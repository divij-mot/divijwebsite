/**
 * Provider adapters.
 *
 * The tests split chunks at hostile boundaries on purpose. Real network reads do not
 * respect message framing, and a parser that only works on whole events looks correct
 * locally and fails intermittently in production.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getPreset, PROVIDER_PRESETS } from '../agent/presets';
import { createChatCompletionsAdapter } from '../agent/providers/chatCompletions';
import { createResponsesAdapter } from '../agent/providers/responses';
import { SseParser } from '../agent/providers/sse';
import type { ProviderEvent, TurnRequest } from '../agent/providers/types';

const encoder = new TextEncoder();

/** Serve a body in caller-chosen chunks so framing can be broken deliberately. */
function mockStream(chunks: string[], status = 200, contentType = 'text/event-stream') {
  return vi.fn(async () => {
    let i = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (i >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunks[i++]));
        },
      }),
      { status, headers: { 'content-type': contentType } },
    );
  });
}

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'fs_read', description: 'read', parameters: { type: 'object', properties: {} } }],
    apiKey: 'sk-test',
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe('SseParser', () => {
  it('reassembles an event split across arbitrary chunk boundaries', () => {
    const parser = new SseParser();
    const events = [
      ...parser.push('data: {"a"'),
      ...parser.push(':1,"b"'),
      ...parser.push(':2}\n'),
      ...parser.push('\n'),
    ];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].data)).toEqual({ a: 1, b: 2 });
  });

  it('handles CRLF line endings', () => {
    const parser = new SseParser();
    expect(parser.push('data: hello\r\n\r\n')[0].data).toBe('hello');
  });

  it('ignores heartbeat comments', () => {
    const parser = new SseParser();
    expect(parser.push(': keep-alive\n\n')).toHaveLength(0);
    expect(parser.push('data: real\n\n')).toHaveLength(1);
  });

  it('joins multi-line data fields', () => {
    const parser = new SseParser();
    expect(parser.push('data: line1\ndata: line2\n\n')[0].data).toBe('line1\nline2');
  });

  it('flushes a trailing event with no blank line', () => {
    const parser = new SseParser();
    expect(parser.push('data: last\n')).toHaveLength(0);
    expect(parser.flush()[0].data).toBe('last');
  });

  it('reads the event name when one is sent', () => {
    const parser = new SseParser();
    const [event] = parser.push('event: response.completed\ndata: {}\n\n');
    expect(event.event).toBe('response.completed');
  });
});

describe('Chat Completions adapter', () => {
  const preset = getPreset('custom');

  it('streams text deltas', async () => {
    vi.stubGlobal(
      'fetch',
      mockStream([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const events = await collect(createChatCompletionsAdapter(preset).stream(request()));
    const text = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Hello');
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('assembles a tool call from fragmented argument deltas', async () => {
    vi.stubGlobal(
      'fetch',
      mockStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fs_read","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ths\\":[\\"a.ts\\"]}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const events = await collect(createChatCompletionsAdapter(preset).stream(request()));
    const call = events.find((e) => e.type === 'tool-call') as { call: { name: string; argumentsJson: string } };
    expect(call.call.name).toBe('fs_read');
    expect(JSON.parse(call.call.argumentsJson)).toEqual({ paths: ['a.ts'] });
  });

  it('keeps two parallel tool calls separate', async () => {
    vi.stubGlobal(
      'fetch',
      mockStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fs_read","arguments":"{\\"a\\":1}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"fs_tree","arguments":"{\\"b\\":2}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]),
    );
    const calls = (await collect(createChatCompletionsAdapter(preset).stream(request())))
      .filter((e) => e.type === 'tool-call')
      .map((e) => (e as { call: { name: string; argumentsJson: string } }).call);
    expect(calls.map((c) => c.name)).toEqual(['fs_read', 'fs_tree']);
    expect(JSON.parse(calls[0].argumentsJson)).toEqual({ a: 1 });
    expect(JSON.parse(calls[1].argumentsJson)).toEqual({ b: 2 });
  });

  it('handles a provider that omits the index field', async () => {
    // Several OpenAI-compatible endpoints send tool calls sequentially with no index.
    vi.stubGlobal(
      'fetch',
      mockStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"fs_read","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]),
    );
    const calls = (await collect(createChatCompletionsAdapter(preset).stream(request()))).filter(
      (e) => e.type === 'tool-call',
    );
    expect(calls).toHaveLength(1);
  });

  it('synthesizes an id when the provider never sends one', async () => {
    vi.stubGlobal(
      'fetch',
      mockStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"fs_tree","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]),
    );
    const call = (await collect(createChatCompletionsAdapter(preset).stream(request()))).find(
      (e) => e.type === 'tool-call',
    ) as { call: { id: string } };
    // Without an id the agent loop cannot correlate the result back to the call.
    expect(call.call.id).toBeTruthy();
  });

  it('still emits tool calls when the provider reports finish_reason "stop"', async () => {
    vi.stubGlobal(
      'fetch',
      mockStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fs_tree","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ]),
    );
    const events = await collect(createChatCompletionsAdapter(preset).stream(request()));
    expect(events.some((e) => e.type === 'tool-call')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool-calls' });
  });

  it('surfaces an authentication failure with the provider message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 }),
      ),
    );
    const events = await collect(createChatCompletionsAdapter(preset).stream(request()));
    expect(events[0].type).toBe('error');
    expect((events[0] as { message: string }).message).toContain('Incorrect API key');
    expect((events[0] as { retryable: boolean }).retryable).toBe(false);
  });

  it('marks rate limits and server errors retryable', async () => {
    for (const status of [429, 500, 503]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
      const [event] = await collect(createChatCompletionsAdapter(preset).stream(request()));
      expect((event as { retryable: boolean }).retryable, `status ${status}`).toBe(true);
    }
  });

  it('reports a mid-stream error frame', async () => {
    vi.stubGlobal(
      'fetch',
      mockStream([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        'data: {"error":{"message":"context length exceeded"}}\n\n',
      ]),
    );
    const events = await collect(createChatCompletionsAdapter(preset).stream(request()));
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'context length exceeded' });
  });

  it('skips malformed frames rather than aborting the stream', async () => {
    vi.stubGlobal(
      'fetch',
      mockStream([
        'data: {not json at all\n\n',
        'data: {"choices":[{"delta":{"content":"survived"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const events = await collect(createChatCompletionsAdapter(preset).stream(request()));
    expect(events.some((e) => e.type === 'text-delta' && e.text === 'survived')).toBe(true);
  });

  it('explains a CORS failure for a custom endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const [event] = await collect(
      createChatCompletionsAdapter(preset, 'https://my-endpoint.test').stream(request()),
    );
    expect((event as { message: string }).message).toMatch(/CORS/);
  });

  it('stops cleanly when the turn is cancelled', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }));
    const events = await collect(
      createChatCompletionsAdapter(preset).stream(request({ signal: controller.signal })),
    );
    // A cancellation is not an error the user needs to see.
    expect(events).toHaveLength(0);
  });
});

describe('Responses adapter', () => {
  const preset = getPreset('openai');

  it('streams text and a tool call', async () => {
    vi.stubGlobal(
      'fetch',
      mockStream([
        'data: {"type":"response.output_text.delta","delta":"Working"}\n\n',
        'data: {"type":"response.output_item.added","item_id":"i1","item":{"type":"function_call","call_id":"c1","name":"fs_tree"}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"i1","delta":"{}"}\n\n',
        'data: {"type":"response.output_item.done","item_id":"i1","item":{"type":"function_call","call_id":"c1","name":"fs_tree","arguments":"{}"}}\n\n',
        'data: {"type":"response.completed","response":{}}\n\n',
      ]),
    );
    const events = await collect(createResponsesAdapter(preset).stream(request()));
    expect(events.some((e) => e.type === 'text-delta' && e.text === 'Working')).toBe(true);
    const call = events.find((e) => e.type === 'tool-call') as { call: { id: string; name: string } };
    expect(call.call).toMatchObject({ id: 'c1', name: 'fs_tree' });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool-calls' });
  });

  it('sends store:false so the provider keeps no conversation copy', async () => {
    const fetchMock = mockStream(['data: {"type":"response.completed","response":{}}\n\n']);
    vi.stubGlobal('fetch', fetchMock);
    await collect(createResponsesAdapter(preset).stream(request()));

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    // History is replayed locally; never resumed from a server-side thread.
    expect(body.previous_response_id).toBeUndefined();
  });

  it('reports truncation caused by the output limit', async () => {
    vi.stubGlobal(
      'fetch',
      mockStream([
        'data: {"type":"response.output_text.delta","delta":"cut"}\n\n',
        'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
      ]),
    );
    const events = await collect(createResponsesAdapter(preset).stream(request()));
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'length' });
  });

  it('routes a relayed preset through the control plane, not the provider', async () => {
    const fetchMock = mockStream(['data: {"type":"response.completed","response":{}}\n\n']);
    vi.stubGlobal('fetch', fetchMock);
    await collect(createResponsesAdapter(preset).stream(request()));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/builder/model/stream');
    // The key travels in a header the relay forwards once; the client never names a host.
    expect((init.headers as Record<string, string>)['X-Builder-Preset']).toBe('openai');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe('presets', () => {
  it('treats an unknown preset id as a custom endpoint rather than relaying it', () => {
    // A stale stored setting must never cause a request to an unintended upstream.
    expect(getPreset('some-removed-provider').transport).toBe('direct');
  });

  it('gives every relayed preset a fixed https upstream', () => {
    for (const preset of PROVIDER_PRESETS.filter((p) => p.transport === 'relay')) {
      expect(preset.baseUrl.startsWith('https://'), preset.id).toBe(true);
    }
  });
});
