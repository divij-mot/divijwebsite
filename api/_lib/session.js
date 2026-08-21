/**
 * Beta session cookie, CSRF, and request plumbing.
 *
 * The session is a signed, stateless token in an HttpOnly SameSite=Strict cookie. It
 * carries an invite-code hash and an issue time, never the code itself and never anything
 * about the user's project. Stateless means a cold Vercel instance can validate it without
 * a lookup; revocation is handled by checking the invite hash against the revocation list
 * on the operations that matter.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { QUOTA_LIMITS } from './limits.js';
import * as store from './store.js';

export const COOKIE_NAME = '__Host-builder_session';

function secret() {
  const s = process.env.BUILDER_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new HttpError(503, 'server_misconfigured', 'BUILDER_SESSION_SECRET must be set to at least 32 characters.');
  }
  return s;
}

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payloadB64) {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

export function issueSession(inviteHash) {
  const payload = {
    h: inviteHash,
    iat: Math.floor(Date.now() / 1000),
    // Distinguishes two sessions from the same invite code, so a per-session egress
    // allowlist cannot be inherited by a later session.
    sid: randomBytes(9).toString('base64url'),
  };
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

export function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const expected = Buffer.from(sign(encoded));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const age = Math.floor(Date.now() / 1000) - (payload.iat || 0);
  if (age > QUOTA_LIMITS.sessionTtlSeconds) return null;
  if (!payload.h || !payload.sid) return null;
  return payload;
}

export function sessionCookie(token) {
  // __Host- requires Secure, Path=/, and no Domain. SameSite=Strict means the cookie is
  // not sent on any cross-site request, which is the primary CSRF defence.
  return [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${QUOTA_LIMITS.sessionTtlSeconds}`,
  ].join('; ');
}

export function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Reject cross-origin writes.
 *
 * SameSite=Strict already blocks the cookie on cross-site requests, but a same-site
 * subdomain or a stray proxy could still reach here, so the Origin header is checked
 * against the deployment's own host as a second gate.
 */
export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // Same-origin fetches from some browsers omit it entirely.

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'bad_origin', 'Malformed Origin header.');
  }

  const allowed = new Set([host]);
  for (const extra of (process.env.BUILDER_ALLOWED_ORIGINS || '').split(',')) {
    const trimmed = extra.trim();
    if (trimmed) allowed.add(trimmed.replace(/^https?:\/\//, ''));
  }
  if (!allowed.has(originHost)) {
    throw new HttpError(403, 'bad_origin', 'Cross-origin requests are not accepted.');
  }
}

/**
 * Load and validate the caller's session, or throw.
 * Also re-checks the invite against the revocation list so a revoked code loses access
 * without waiting for its 12-hour session to expire.
 */
export async function requireSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies[COOKIE_NAME]);
  if (!session) throw new HttpError(401, 'no_session', 'Sign in with your invite code.');

  if (await store.get(`invite:revoked:${session.h}`)) {
    throw new HttpError(403, 'invite_revoked', 'This invite code has been revoked.');
  }
  if (await store.isKillSwitchOn()) {
    throw new HttpError(503, 'builder_disabled', 'The builder is temporarily disabled.');
  }
  return session;
}

/** First forwarded address, used only for per-IP abuse counters. */
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

export function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function sendError(res, err) {
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });
  }
  if (err?.name === 'MosaicError') {
    // Surface the sandbox provider's own status so the UI can distinguish "their outage"
    // from "your mistake", but never leak the request body or our API key.
    const status = err.status >= 500 || !err.status ? 502 : err.status;
    return sendJson(res, status, {
      error: 'sandbox_provider_error',
      message: err.message,
      request_id: err.requestId,
      retryable: Boolean(err.retryable),
    });
  }
  console.error('[builder] unhandled', err?.message || err);
  return sendJson(res, 500, { error: 'internal_error', message: 'Something went wrong.' });
}

export async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') return req.body;

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(413, 'body_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

export function methodGuard(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  res.setHeader('Allow', allowed.join(', '));
  sendJson(res, 405, { error: 'method_not_allowed' });
  return false;
}

/**
 * Cloudflare Turnstile, skipped entirely when no secret is configured.
 * Free and optional; the invite code is the real gate.
 */
export async function verifyTurnstile(token, ip) {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey) return { ok: true, skipped: true };
  if (!token) throw new HttpError(400, 'turnstile_required', 'Complete the verification challenge.');

  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (ip && ip !== 'unknown') body.set('remoteip', ip);

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);

  const json = res ? await res.json().catch(() => null) : null;
  if (!json?.success) {
    throw new HttpError(403, 'turnstile_failed', 'Verification challenge failed. Try again.');
  }
  return { ok: true, skipped: false };
}
