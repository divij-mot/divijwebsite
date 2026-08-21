/**
 * POST /api/builder/model/stream
 *
 * A stateless relay to an approved model provider, for providers that do not send CORS
 * headers and therefore cannot be called from the browser directly.
 *
 * The important property is what this does NOT do. It picks the upstream host itself from
 * a fixed table, so a caller cannot point it anywhere (that would be a server-side request
 * forgery with our egress). It pipes the upstream body straight through without buffering,
 * parsing, or logging it. It keeps nothing: not the prompt, not the response, not the key,
 * which arrives in a header, is forwarded once, and is never written down.
 *
 * Providers that do send CORS headers are called directly by the Agent Worker and never
 * reach this file at all.
 */

import { createHmac } from 'node:crypto';

import { assertSameOrigin, HttpError, requireSession, sendError, sendJson } from '../../_lib/session.js';
import * as store from '../../_lib/store.js';

export const config = { runtime: 'nodejs', maxDuration: 300 };

/**
 * The allowlist. The client sends a preset id; the host is resolved here. Adding a
 * provider means editing this table, which is the point.
 */
const PRESETS = {
  openai: {
    origin: 'https://api.openai.com',
    paths: ['/v1/responses', '/v1/chat/completions', '/v1/models'],
  },
  openrouter: {
    origin: 'https://openrouter.ai',
    paths: ['/api/v1/chat/completions', '/api/v1/models'],
    extraHeaders: {
      // OpenRouter attributes traffic by these; they contain no user data.
      'HTTP-Referer': 'https://divijmotwani.com/builder',
      'X-Title': 'Divij Builder',
    },
  },
  fireworks: {
    origin: 'https://api.fireworks.ai',
    paths: ['/inference/v1/chat/completions', '/inference/v1/models'],
  },
};

/** Per-session request ceiling, so a stolen session cannot be used to burn a relay budget. */
const MAX_REQUESTS_PER_HOUR = 400;

/**
 * A stable, non-reversible per-session identifier for OpenAI's `safety_identifier`.
 *
 * OpenAI asks for an end-user identifier to attribute abuse. Sending anything real would
 * be a privacy regression, so this is an HMAC of the session id under a server secret:
 * stable enough for OpenAI to correlate, useless to anyone who obtains it.
 */
function safetyIdentifier(sessionId) {
  const secret = process.env.BUILDER_SESSION_SECRET || '';
  return createHmac('sha256', secret).update(`safety:${sessionId}`).digest('hex').slice(0, 32);
}

export default async function handler(req, res) {
  let session;
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }
    session = await requireSession(req);
    assertSameOrigin(req);

    const preset = PRESETS[String(req.headers['x-builder-preset'] || '')];
    if (!preset) {
      throw new HttpError(
        400,
        'unknown_preset',
        'Unknown provider preset. Custom endpoints are called directly from the browser, not relayed.',
      );
    }

    const path = String(req.headers['x-builder-path'] || '');
    if (!preset.paths.includes(path)) {
      throw new HttpError(400, 'path_not_allowed', `This preset does not relay ${path}.`);
    }

    const apiKey = req.headers['x-builder-key'];
    if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 400) {
      throw new HttpError(400, 'missing_key', 'A provider API key is required.');
    }

    const used = await store.incrementWithTtl(
      `relay:${session.sid}:${Math.floor(Date.now() / 3_600_000)}`,
      3600,
    );
    if (used > MAX_REQUESTS_PER_HOUR) {
      throw new HttpError(429, 'relay_limit', 'Too many model requests this hour.');
    }
  } catch (err) {
    return sendError(res, err);
  }

  const preset = PRESETS[String(req.headers['x-builder-preset'])];
  const path = String(req.headers['x-builder-path']);
  const apiKey = String(req.headers['x-builder-key']);

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    // The body is forwarded as an opaque stream. It is never parsed here, so there is no
    // point at which prompt content exists as a value this process could log.
    const upstream = await fetch(`${preset.origin}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: req.headers.accept || 'text/event-stream',
        ...(preset.extraHeaders || {}),
        ...(req.headers['x-builder-safety'] === '1'
          ? { 'X-Safety-Identifier': safetyIdentifier(session.sid) }
          : {}),
      },
      body: req,
      duplex: 'half',
      signal: controller.signal,
    });

    res.statusCode = upstream.status;
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (controller.signal.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }
    // The upstream error message can be shown; it usually says "invalid api key" or
    // "model not found", which the user needs. It never contains their prompt.
    if (!res.headersSent) {
      return sendJson(res, 502, {
        error: 'upstream_unreachable',
        message: `Could not reach the model provider: ${String(err?.message || err).slice(0, 200)}`,
      });
    }
    res.end();
  }
}
