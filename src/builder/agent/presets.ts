/**
 * Provider presets.
 *
 * `transport` decides who makes the request. A relayed preset goes through
 * /api/builder/model/stream, which resolves the upstream host from its own fixed table --
 * the client sends a preset id, never a URL, so this list cannot be used to aim our server
 * at an arbitrary address. A direct preset is fetched by the worker, which keeps the key
 * entirely in the browser but requires the provider to send CORS headers.
 *
 * Anything not listed here is a custom endpoint and is always direct.
 */

import type { ProviderPreset } from '../core/types';

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com',
    transport: 'relay',
    defaultModel: 'gpt-5.1',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai',
    transport: 'relay',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    protocol: 'openai-chat',
    baseUrl: 'https://api.fireworks.ai',
    transport: 'relay',
    defaultModel: 'accounts/fireworks/models/kimi-k2-instruct',
    docsUrl: 'https://fireworks.ai/account/api-keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    // Direct rather than relayed: DeepSeek reflects the request Origin in its CORS
    // headers, so the browser can call it itself and the key never reaches our server at
    // all. That is strictly better than relaying, which is only a workaround for
    // providers that refuse browser requests.
    transport: 'direct',
    defaultModel: 'deepseek-v4-pro',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    protocol: 'openai-chat',
    baseUrl: '',
    transport: 'direct',
    defaultModel: '',
  },
];

export function getPreset(id: string): ProviderPreset {
  const found = PROVIDER_PRESETS.find((p) => p.id === id);
  if (found) return found;
  // An unknown id is treated as a custom endpoint rather than silently relayed, so a
  // stale stored setting can never cause a request to an unintended upstream.
  return PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}

/** Suggestions only; any model string the provider accepts works. */
export const SUGGESTED_MODELS: Record<string, string[]> = {
  openai: ['gpt-5.1', 'gpt-5.1-mini', 'gpt-5', 'gpt-4.1'],
  openrouter: [
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-opus-4.1',
    'openai/gpt-5.1',
    'google/gemini-2.5-pro',
    'deepseek/deepseek-v3.2',
  ],
  fireworks: [
    'accounts/fireworks/models/kimi-k2-instruct',
    'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct',
    'accounts/fireworks/models/deepseek-v3p1',
  ],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  custom: [],
};
