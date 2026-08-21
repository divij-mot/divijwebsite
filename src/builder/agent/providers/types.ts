/**
 * The provider abstraction.
 *
 * Two wire protocols are supported: OpenAI's Responses API (their recommendation for
 * tool-calling workflows) and streamed Chat Completions (which every OpenAI-compatible
 * endpoint speaks). Both are normalized to the same event stream so the agent loop never
 * branches on protocol.
 */

import type { ProviderCapabilities, ProviderPreset } from '../../core/types';

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type TurnMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: string[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; images?: string[] };

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON text as the model produced it; parsed by the caller so it can report bad JSON. */
  argumentsJson: string;
}

export type ProviderEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCallRequest }
  | { type: 'done'; finishReason: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'unknown' }
  | { type: 'error'; message: string; retryable: boolean };

export interface TurnRequest {
  model: string;
  messages: TurnMessage[];
  tools: ToolSchema[];
  apiKey: string;
  signal: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  /** Sends a privacy-preserving safety identifier where the provider supports one. */
  safetyIdentifier?: boolean;
}

export interface ProviderAdapter {
  readonly protocol: 'openai-responses' | 'openai-chat';
  stream(request: TurnRequest): AsyncGenerator<ProviderEvent, void, unknown>;
  /** Probe authentication, streaming, tool calling, and vision without a full turn. */
  test(apiKey: string, model: string, signal: AbortSignal): Promise<ProbeResult>;
}

export interface ProbeResult {
  capabilities: ProviderCapabilities;
  errors: string[];
  warnings: string[];
}

/**
 * Where a request is sent.
 *
 * A relayed preset goes to our own /api/builder/model/stream, which picks the upstream
 * host from a fixed table so a caller cannot aim it at an arbitrary address. A direct
 * endpoint is fetched by the worker itself and needs provider CORS support; the key never
 * leaves the browser in that case.
 */
export interface Endpoint {
  url: string;
  headers: Record<string, string>;
}

export const RELAY_URL = '/api/builder/model/stream';

export function resolveEndpoint(
  preset: ProviderPreset,
  path: string,
  apiKey: string,
  customBaseUrl?: string,
  safetyIdentifier?: boolean,
): Endpoint {
  if (preset.transport === 'relay') {
    return {
      url: RELAY_URL,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Builder-Preset': preset.id,
        'X-Builder-Path': path,
        'X-Builder-Key': apiKey,
        ...(safetyIdentifier ? { 'X-Builder-Safety': '1' } : {}),
      },
    };
  }
  const base = (customBaseUrl || preset.baseUrl).replace(/\/+$/, '');
  return {
    url: `${base}${path}`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    },
  };
}
