/**
 * OpenAI-compatible Chat Completions adapter.
 *
 * This is the lowest common denominator: OpenRouter, Fireworks, Together, Groq, vLLM,
 * llama.cpp, LM Studio, and Ollama all speak it. It is what a custom endpoint gets.
 *
 * The fiddly part is tool-call deltas. Providers stream them as partial objects indexed by
 * position, and they disagree about nearly everything: whether `id` appears on the first
 * chunk or the last, whether `index` is present at all, and whether the final chunk
 * repeats fields or omits them. The accumulator below tolerates all of those rather than
 * assuming OpenAI's exact shape, because assuming it breaks on roughly half of the
 * compatible endpoints in practice.
 */

import type { ProviderCapabilities, ProviderPreset } from '../../core/types';
import { describeProviderError, readSse } from './sse';
import {
  resolveEndpoint,
  type ProbeResult,
  type ProviderAdapter,
  type ProviderEvent,
  type ToolCallRequest,
  type TurnMessage,
  type TurnRequest,
} from './types';

const PATH_BY_PRESET: Record<string, string> = {
  openrouter: '/api/v1/chat/completions',
  fireworks: '/inference/v1/chat/completions',
};
const DEFAULT_PATH = '/v1/chat/completions';

interface ChatMessagePayload {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

function toChatMessages(messages: TurnMessage[]): ChatMessagePayload[] {
  const out: ChatMessagePayload[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.content });
      continue;
    }

    if (message.role === 'user') {
      if (message.images?.length) {
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: message.content },
            ...message.images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ],
        });
      } else {
        out.push({ role: 'user', content: message.content });
      }
      continue;
    }

    if (message.role === 'assistant') {
      out.push({
        role: 'assistant',
        // An assistant turn that is only tool calls must still carry a content field;
        // several providers reject the message outright when it is missing.
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.argumentsJson || '{}' },
              })),
            }
          : {}),
      });
      continue;
    }

    out.push({ role: 'tool', tool_call_id: message.toolCallId, name: message.name, content: message.content });
    // The tool role does not accept image parts, so a screenshot follows as a user turn.
    if (message.images?.length) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: `Screenshot from ${message.name}:` },
          ...message.images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      });
    }
  }
  return out;
}

interface DeltaToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** Assembles fragmented tool-call deltas into complete calls. */
class ToolCallAccumulator {
  private readonly slots = new Map<number, { id: string; name: string; args: string }>();
  private nextImplicitIndex = 0;

  add(delta: DeltaToolCall): void {
    // Providers that omit `index` send calls sequentially, so position is inferred. Using
    // a shared bucket instead would concatenate two different calls' arguments.
    const index = typeof delta.index === 'number' ? delta.index : this.nextImplicitIndex;
    if (typeof delta.index !== 'number' && delta.id) this.nextImplicitIndex += 1;

    const slot = this.slots.get(index) ?? { id: '', name: '', args: '' };
    if (delta.id) slot.id = delta.id;
    if (delta.function?.name) slot.name = delta.function.name;
    if (delta.function?.arguments) slot.args += delta.function.arguments;
    this.slots.set(index, slot);
  }

  drain(): ToolCallRequest[] {
    const calls: ToolCallRequest[] = [];
    for (const [index, slot] of [...this.slots.entries()].sort((a, b) => a[0] - b[0])) {
      if (!slot.name) continue;
      calls.push({
        // Some endpoints never send an id; the loop needs one to correlate the result.
        id: slot.id || `call_${index}_${Math.random().toString(36).slice(2, 10)}`,
        name: slot.name,
        argumentsJson: slot.args || '{}',
      });
    }
    this.slots.clear();
    this.nextImplicitIndex = 0;
    return calls;
  }

  get size(): number {
    return this.slots.size;
  }
}

export function createChatCompletionsAdapter(
  preset: ProviderPreset,
  customBaseUrl?: string,
): ProviderAdapter {
  const path = PATH_BY_PRESET[preset.id] ?? DEFAULT_PATH;

  return {
    protocol: 'openai-chat',

    async *stream(request: TurnRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      const endpoint = resolveEndpoint(preset, path, request.apiKey, customBaseUrl);
      const body = {
        model: request.model,
        messages: toChatMessages(request.messages),
        stream: true,
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        tool_choice: request.tools.length ? 'auto' : undefined,
        tools: request.tools.length
          ? request.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            }))
          : undefined,
      };

      let response: Response;
      try {
        response = await fetch(endpoint.url, {
          method: 'POST',
          headers: endpoint.headers,
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (err) {
        if (request.signal.aborted) return;
        yield {
          type: 'error',
          message:
            preset.transport === 'direct'
              ? `Could not reach ${customBaseUrl || preset.baseUrl}. A custom endpoint must send CORS headers permitting this origin.`
              : `Could not reach the provider: ${(err as Error).message}`,
          retryable: true,
        };
        return;
      }

      if (!response.ok) {
        yield {
          type: 'error',
          message: await describeProviderError(response),
          retryable: response.status === 429 || response.status >= 500,
        };
        return;
      }

      const accumulator = new ToolCallAccumulator();
      let finishReason: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'unknown' = 'unknown';

      for await (const event of readSse(response, request.signal)) {
        if (event.data === '[DONE]') break;
        let payload: {
          choices?: Array<{
            delta?: { content?: string | null; tool_calls?: DeltaToolCall[] };
            finish_reason?: string | null;
          }>;
          error?: { message?: string };
        };
        try {
          payload = JSON.parse(event.data);
        } catch {
          continue;
        }

        // Some providers deliver a mid-stream error as a normal data frame.
        if (payload.error?.message) {
          yield { type: 'error', message: payload.error.message, retryable: false };
          return;
        }

        const choice = payload.choices?.[0];
        if (!choice) continue;

        if (choice.delta?.content) yield { type: 'text-delta', text: choice.delta.content };
        for (const call of choice.delta?.tool_calls ?? []) accumulator.add(call);

        if (choice.finish_reason) {
          finishReason =
            choice.finish_reason === 'tool_calls'
              ? 'tool-calls'
              : choice.finish_reason === 'length'
                ? 'length'
                : choice.finish_reason === 'content_filter'
                  ? 'content-filter'
                  : 'stop';
        }
      }

      // Emit accumulated calls regardless of finish_reason: some endpoints stream tool
      // calls and then report "stop", and dropping them would stall the agent silently.
      const calls = accumulator.drain();
      for (const call of calls) yield { type: 'tool-call', call };
      yield { type: 'done', finishReason: calls.length ? 'tool-calls' : finishReason === 'unknown' ? 'stop' : finishReason };
    },

    async test(apiKey, model, signal): Promise<ProbeResult> {
      const errors: string[] = [];
      const warnings: string[] = [];
      const capabilities: ProviderCapabilities = { streaming: false, functionCalling: false, vision: false };

      const endpoint = resolveEndpoint(preset, path, apiKey, customBaseUrl);
      const probe = {
        model,
        messages: [{ role: 'user', content: 'Call the ping tool with value "ok".' }],
        stream: true,
        max_tokens: 64,
        tool_choice: 'auto',
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping',
              description: 'Acknowledge the connection test.',
              parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
            },
          },
        ],
      };

      let response: Response;
      try {
        response = await fetch(endpoint.url, {
          method: 'POST',
          headers: endpoint.headers,
          body: JSON.stringify(probe),
          signal,
        });
      } catch (err) {
        errors.push(
          preset.transport === 'direct'
            ? `Could not reach ${customBaseUrl || preset.baseUrl}. Check the URL, and confirm the endpoint allows browser requests from this origin (CORS).`
            : `Could not reach the provider: ${(err as Error).message}`,
        );
        return { capabilities, errors, warnings };
      }

      if (!response.ok) {
        errors.push(await describeProviderError(response));
        return { capabilities, errors, warnings };
      }

      const accumulator = new ToolCallAccumulator();
      for await (const event of readSse(response, signal)) {
        if (event.data === '[DONE]') break;
        capabilities.streaming = true;
        try {
          const payload = JSON.parse(event.data);
          for (const call of payload.choices?.[0]?.delta?.tool_calls ?? []) accumulator.add(call);
        } catch {
          /* ignore malformed probe frames */
        }
      }
      capabilities.functionCalling = accumulator.drain().length > 0;

      if (!capabilities.streaming) {
        errors.push('The endpoint responded but did not stream. Streaming is required.');
      }
      if (!capabilities.functionCalling) {
        errors.push('The model did not produce a tool call. Agent mode needs function calling.');
      }

      capabilities.vision = /gpt-4o|gpt-4\.1|gpt-5|claude|gemini|llava|pixtral|qwen.*vl|vision|o[34]/i.test(model);
      if (!capabilities.vision) {
        warnings.push('This model appears not to accept images, so verification will use the DOM and console instead of screenshots.');
      }

      return { capabilities, errors, warnings };
    },
  };
}
