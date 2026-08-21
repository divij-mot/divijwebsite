/**
 * The only server-side state the builder keeps.
 *
 * PLAN: "Never store project paths, prompts, source, tool payloads, screenshots, model
 * keys, or provider responses." What is here instead: hashed invite records, quota
 * counters, workspace leases, preview ids, egress allowlists, and a kill switch.
 *
 * Redis is optional. Without UPSTASH_REDIS_REST_URL the store falls back to per-instance
 * memory, which is enough for a single-user beta but loses counters when a Vercel
 * instance recycles. `store.durable` says which mode is active so callers can warn.
 *
 * Leases deliberately do not need Redis at all: the workspace-to-sandbox mapping lives in
 * the Mosaic sandbox's own `metadata` labels, so a cold Vercel instance can find an
 * existing sandbox by querying Mosaic rather than by remembering anything.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export const durable = Boolean(REST_URL && REST_TOKEN);

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

async function redis(command) {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Redis ${command[0]} failed: ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Redis ${command[0]}: ${body.error}`);
  return body.result;
}

/** Process-local fallback with the same surface, including expiry. */
const memory = new Map();

function memGet(key) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key, value, ttlSeconds) {
  memory.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0,
  });
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export async function get(key) {
  if (durable) return redis(['GET', key]);
  return memGet(key);
}

export async function set(key, value, ttlSeconds) {
  if (durable) {
    return ttlSeconds ? redis(['SET', key, value, 'EX', String(ttlSeconds)]) : redis(['SET', key, value]);
  }
  memSet(key, value, ttlSeconds);
  return 'OK';
}

export async function del(key) {
  if (durable) return redis(['DEL', key]);
  memory.delete(key);
  return 1;
}

/**
 * Atomic increment with an expiry applied on first write.
 *
 * The expiry must be set only when the counter is created; refreshing it on every
 * increment would turn a fixed window into a sliding one that never resets under load.
 */
export async function incrementWithTtl(key, ttlSeconds) {
  if (durable) {
    const count = await redis(['INCR', key]);
    if (count === 1) await redis(['EXPIRE', key, String(ttlSeconds)]);
    return count;
  }
  const current = memGet(key);
  const next = (Number(current) || 0) + 1;
  const existing = memory.get(key);
  memSet(key, String(next), current === null ? ttlSeconds : undefined);
  if (current !== null && existing?.expiresAt) {
    memory.get(key).expiresAt = existing.expiresAt;
  }
  return next;
}

export async function addToSet(key, member, ttlSeconds) {
  if (durable) {
    const r = await redis(['SADD', key, member]);
    if (ttlSeconds) await redis(['EXPIRE', key, String(ttlSeconds)]);
    return r;
  }
  const current = new Set(JSON.parse(memGet(key) || '[]'));
  current.add(member);
  memSet(key, JSON.stringify([...current]), ttlSeconds);
  return 1;
}

export async function readSet(key) {
  if (durable) return (await redis(['SMEMBERS', key])) || [];
  return JSON.parse(memGet(key) || '[]');
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

const hashCode = (code) => createHash('sha256').update(String(code).trim()).digest('hex');

/**
 * Validate an invite code.
 *
 * Codes are compared by hash so a plaintext code is never stored or logged. Two sources
 * are accepted: a Redis set of hashes (revocable at runtime) and a BUILDER_INVITE_CODES
 * environment variable (so a solo deployment needs no Redis at all).
 */
export async function checkInvite(code) {
  if (!code || typeof code !== 'string' || code.length < 6 || code.length > 128) {
    return { ok: false, reason: 'invalid_format' };
  }
  const hash = hashCode(code);

  if (await get(`invite:revoked:${hash}`)) return { ok: false, reason: 'revoked' };

  const envCodes = (process.env.BUILDER_INVITE_CODES || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  for (const candidate of envCodes) {
    const a = Buffer.from(hashCode(candidate), 'hex');
    const b = Buffer.from(hash, 'hex');
    // Constant-time compare so response timing does not reveal a partial match.
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, hash };
  }

  if (durable && (await redis(['SISMEMBER', 'invite:codes', hash]))) return { ok: true, hash };

  return { ok: false, reason: 'unknown_code' };
}

export async function revokeInvite(code) {
  const hash = hashCode(code);
  await set(`invite:revoked:${hash}`, '1', 365 * 24 * 60 * 60);
  if (durable) await redis(['SREM', 'invite:codes', hash]);
}

export async function registerInvite(code) {
  const hash = hashCode(code);
  if (!durable) throw new Error('Registering invites at runtime requires Redis.');
  await redis(['SADD', 'invite:codes', hash]);
  await del(`invite:revoked:${hash}`);
  return hash;
}

// ---------------------------------------------------------------------------
// Quotas and the kill switch
// ---------------------------------------------------------------------------

/**
 * Fixed-window counters. Returns the decision plus the numbers, so the caller can tell
 * the user how long to wait instead of a bare 429.
 */
export async function checkAndConsumeQuota(subject, limits) {
  const hourKey = `quota:h:${subject}:${Math.floor(Date.now() / 3_600_000)}`;
  const dayKey = `quota:d:${subject}:${Math.floor(Date.now() / 86_400_000)}`;

  const hour = await incrementWithTtl(hourKey, 3600);
  if (hour > limits.sandboxesPerHour) {
    return { ok: false, reason: 'hourly_limit', hour, limit: limits.sandboxesPerHour, retryAfterSeconds: 3600 };
  }
  const day = await incrementWithTtl(dayKey, 86_400);
  if (day > limits.sandboxesPerDay) {
    return { ok: false, reason: 'daily_limit', day, limit: limits.sandboxesPerDay, retryAfterSeconds: 86_400 };
  }
  return { ok: true, hour, day };
}

export async function isKillSwitchOn() {
  if (process.env.BUILDER_DISABLED === '1') return true;
  return Boolean(await get('builder:killswitch'));
}

export async function setKillSwitch(on) {
  if (on) await set('builder:killswitch', '1');
  else await del('builder:killswitch');
}

// ---------------------------------------------------------------------------
// Egress allowlist
// ---------------------------------------------------------------------------

const egressKey = (workspaceId) => `egress:${workspaceId}`;

export function addEgressHost(workspaceId, hostname) {
  return addToSet(egressKey(workspaceId), hostname, 4 * 60 * 60);
}

export function listEgressHosts(workspaceId) {
  return readSet(egressKey(workspaceId));
}

export function clearEgressHosts(workspaceId) {
  return del(egressKey(workspaceId));
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

export function rememberPreview(workspaceId, previewId, expiresAt) {
  return set(`preview:${workspaceId}`, JSON.stringify({ previewId, expiresAt }), 24 * 60 * 60);
}

export async function recallPreview(workspaceId) {
  const raw = await get(`preview:${workspaceId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function forgetPreview(workspaceId) {
  return del(`preview:${workspaceId}`);
}

/** Test seam. */
export function resetMemoryStore() {
  memory.clear();
}
