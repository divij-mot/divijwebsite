/**
 * OpenAI Responses API adapter.
 *
 * Used for the official OpenAI preset because it is what OpenAI recommends for
 * tool-calling workflows. Two settings matter for this product:
 *
 *   store: false          -- OpenAI does not retain the conversation server-side, so
 *                            "chats are not saved in the cloud" holds for the provider
 *                            leg too, subject to their own retention policy.
 *   previous_response_id  -- deliberately never sent. History is replayed from the
 *                            browser's local copy on every turn, so there is no
 *                            server-side thread to lose or leak.
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

const PATH = '/v1/responses';

interface ResponsesContentPart {
  type: string;
  text?: string;
  image_url?: string;
  detail?: string;
}

interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: ResponsesContentPart[] | string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

/**
 * The Responses API models a conversation as a flat list of typed items rather than
 * role-tagged messages, so tool calls and their results are siblings of the assistant
 * text rather than nested inside it.
 */
function toInputItems(messages: TurnMessage[]): { instructions: string; input: ResponsesInputItem[] } {
  const input: ResponsesInputItem[] = [];
  let instructions = '';

  for (const message of messages) {
    if (message.role === 'system') {
      instructions = instructions ? `${instructions}\n\n${message.content}` : message.content;
      continue;
    }

    if (message.role === 'user') {
      const content: ResponsesContentPart[] = [{ type: 'input_text', text: message.content }];
      for (const image of message.images ?? []) {
        content.push({ type: 'input_image', image_url: image, detail: 'auto' });
      }
      input.push({ role: 'user', content });
      continue;
    }

    if (message.role === 'assistant') {
      if (message.content) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.argumentsJson,
        });
      }
      continue;
    }

    // Tool results. Images from a screenshot cannot ride inside function_call_output, so
    // they follow as a separate user item that references the same step.
    input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
    if (message.images?.length) {
      input.push({
        role: 'user',
        content: [
          { type: 'input_text', text: `Screenshot from ${message.name}:` },
          ...message.images.map((image) => ({ type: 'input_image', image_url: image, detail: 'auto' as const })),
        ],
      });
    }
  }

  return { instructions, input };
}

export function createResponsesAdapter(preset: ProviderPreset, customBaseUrl?: string): ProviderAdapter {
  return {
    protocol: 'openai-responses',

    async *stream(request: TurnRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      const { instructions, input } = toInputItems(request.messages);
      const endpoint = resolveEndpoint(preset, PATH, request.apiKey, customBaseUrl, request.safetyIdentifier);

      const body = {
        model: request.model,
        instructions: instructions || undefined,
        input,
        stream: true,
        store: false,
        parallel_tool_calls: false,
        max_output_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        tools: request.tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: false,
        })),
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
        yield { type: 'error', message: `Could not reach the provider: ${(err as Error).message}`, retryable: true };
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

      // Arguments stream in fragments keyed by item id, so each call is assembled before
      // being emitted once complete.
      const pending = new Map<string, { name: string; args: string; callId: string }>();
      let finishReason: 'stop' | 'tool-calls' | 'length' | 'unknown' = 'unknown';
      let sawToolCall = false;

      for await (const event of readSse(response, request.signal)) {
        if (event.data === '[DONE]') break;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(event.data);
        } catch {
          continue;
        }

        const type = String(payload.type || event.event);

        if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
          yield { type: 'text-delta', text: payload.delta };
          continue;
        }

        if (type === 'response.output_item.added') {
          const item = payload.item as ResponsesInputItem | undefined;
          if (item?.type === 'function_call') {
            pending.set(String(payload.item_id ?? item.call_id ?? ''), {
              name: item.name ?? '',
              args: '',
              callId: item.call_id ?? String(payload.item_id ?? ''),
            });
          }
          continue;
        }

        if (type === 'response.function_call_arguments.delta') {
          const key = String(payload.item_id ?? '');
          const entry = pending.get(key) ?? { name: '', args: '', callId: key };
          entry.args += String(payload.delta ?? '');
          pending.set(key, entry);
          continue;
        }

        if (type === 'response.output_item.done') {
          const item = payload.item as ResponsesInputItem | undefined;
          if (item?.type !== 'function_call') continue;
          const key = String(payload.item_id ?? item.call_id ?? '');
          const entry = pending.get(key);
          const call: ToolCallRequest = {
            id: item.call_id ?? entry?.callId ?? key,
            name: item.name ?? entry?.name ?? '',
            // The terminal item carries the authoritative arguments; deltas are a fallback
            // for providers that omit them here.
            argumentsJson: item.arguments ?? entry?.args ?? '',
          };
          pending.delete(key);
          if (call.name) {
            sawToolCall = true;
            yield { type: 'tool-call', call };
          }
          continue;
        }

        if (type === 'response.completed' || type === 'response.incomplete') {
          const reason = (payload.response as { incomplete_details?: { reason?: string } } | undefined)
            ?.incomplete_details?.reason;
          finishReason = reason === 'max_output_tokens' ? 'length' : sawToolCall ? 'tool-calls' : 'stop';
          continue;
        }

        if (type === 'response.failed' || type === 'error') {
          const message =
            (payload.response as { error?: { message?: string } } | undefined)?.error?.message ||
            (payload as { message?: string }).message ||
            'The provider reported a failure.';
          yield { type: 'error', message, retryable: false };
          return;
        }
      }

      yield { type: 'done', finishReason: finishReason === 'unknown' && sawToolCall ? 'tool-calls' : finishReason };
    },

    async test(apiKey, model, signal): Promise<ProbeResult> {
      const errors: string[] = [];
      const warnings: string[] = [];
      const capabilities: ProviderCapabilities = { streaming: false, functionCalling: false, vision: false };

      const endpoint = resolveEndpoint(preset, PATH, apiKey, customBaseUrl);
      const probe = {
        model,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Call the ping tool with value "ok".' }] }],
        stream: true,
        store: false,
        max_output_tokens: 64,
        tools: [
          {
            type: 'function',
            name: 'ping',
            description: 'Acknowledge the connection test.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
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
            ? `Could not reach ${preset.baseUrl}. If this is a custom endpoint, it must send CORS headers allowing this origin.`
            : `Could not reach the provider: ${(err as Error).message}`,
        );
        return { capabilities, errors, warnings };
      }

      if (!response.ok) {
        errors.push(await describeProviderError(response));
        return { capabilities, errors, warnings };
      }

      for await (const event of readSse(response, signal)) {
        if (event.data === '[DONE]') break;
        capabilities.streaming = true;
        try {
          const payload = JSON.parse(event.data);
          if (String(payload.type).startsWith('response.function_call_arguments') ||
              (payload.item as { type?: string } | undefined)?.type === 'function_call') {
            capabilities.functionCalling = true;
          }
        } catch {
          /* a malformed frame during a probe is not worth failing on */
        }
      }

      if (!capabilities.streaming) errors.push('The provider accepted the request but sent no stream.');
      if (!capabilities.functionCalling) {
        errors.push('The model did not produce a tool call, so it cannot drive the agent.');
      }

      // Vision is inferred from the model name rather than probed: sending a real image
      // costs tokens on every connection test, and a wrong guess only downgrades
      // verification to DOM and console inspection.
      capabilities.vision = /gpt-4o|gpt-4\.1|gpt-5|o[34]|vision|omni/i.test(model);
      if (!capabilities.vision) {
        warnings.push('This model appears not to accept images, so the agent will verify using the DOM and console instead of screenshots.');
      }

      return { capabilities, errors, warnings };
    },
  };
}
