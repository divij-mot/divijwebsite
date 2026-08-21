/**
 * Resolve Mosaic credentials for the local scripts.
 *
 * Order: explicit environment, then the repo's .env, then the `mos` CLI config. The token
 * is returned but never logged; callers print request IDs instead.
 *
 * MOSAIC_API_KEY is the name used in .env and on Vercel; MOSAIC_API_TOKEN and
 * MAR_API_TOKEN are accepted because the Mosaic docs and SDK use those.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TOKEN_KEYS = ['MOSAIC_API_KEY', 'MOSAIC_API_TOKEN', 'MAR_API_TOKEN'];
const ENDPOINT_KEYS = ['MOSAIC_API_URL', 'MOSAIC_ENDPOINT', 'MAR_ENDPOINT'];

/** Minimal .env reader: KEY=VALUE, optional quotes, `#` comments, no interpolation. */
function readDotEnv(path) {
  const out = {};
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return out;
}

export function resolveMosaicAuth({ required = true } = {}) {
  const dotenv = readDotEnv(join(REPO_ROOT, '.env'));
  const pick = (keys) => {
    for (const k of keys) {
      if (process.env[k]) return { value: process.env[k], source: `env:${k}` };
      if (dotenv[k]) return { value: dotenv[k], source: `.env:${k}` };
    }
    return null;
  };

  let token = pick(TOKEN_KEYS);
  let endpoint = pick(ENDPOINT_KEYS);

  if (!token || !endpoint) {
    try {
      const cfg = JSON.parse(
        readFileSync(join(homedir(), '.config', 'mosaic-sandbox', 'config.json'), 'utf8'),
      );
      token ||= cfg.token || cfg.api_token ? { value: cfg.token || cfg.api_token, source: 'mos-cli' } : null;
      endpoint ||= cfg.endpoint || cfg.api_url ? { value: cfg.endpoint || cfg.api_url, source: 'mos-cli' } : null;
    } catch {
      /* handled below */
    }
  }

  if (!token && required) {
    throw new Error(
      'No Mosaic credential. Set MOSAIC_API_KEY in .env, export MOSAIC_API_TOKEN, or run `mos auth --token ...`.',
    );
  }

  return {
    token: token?.value ?? '',
    endpoint: endpoint?.value ?? 'https://sandbox.mosaicos.com',
    tokenSource: token?.source ?? 'none',
  };
}
