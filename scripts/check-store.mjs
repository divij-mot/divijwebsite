#!/usr/bin/env node
/**
 * Verifies the durable store is wired up and behaving.
 *
 * Worth having as its own script because the failure mode is silent: without Redis the
 * store falls back to per-instance memory and every API call still succeeds, but quotas
 * count from zero on each serverless invocation and enforce nothing. Nothing surfaces
 * that except `durable_store: false` in the auth response.
 *
 *   node scripts/check-store.mjs
 *
 * Reads credentials from .env.local (written by the Vercel Upstash integration) or .env.
 * Test keys are namespaced under `selftest:` and cleaned up.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// .env.local wins: that is where the Vercel integration writes, and it is the fresher copy.
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value && !process.env[key]) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

const store = await import('../api/_lib/store.js');
const { QUOTA_LIMITS } = await import('../api/_lib/limits.js');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const suffix = Math.random().toString(36).slice(2, 8);
const keys = [];
const key = (name) => {
  const k = `selftest:${name}:${suffix}`;
  keys.push(k);
  return k;
};

try {
  console.log(`\nStore driver: ${store.durable ? 'Upstash Redis (durable)' : 'in-process memory (NOT durable)'}\n`);
  record(
    'durable driver is active',
    store.durable,
    store.durable ? '' : 'set UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN',
  );
  if (!store.durable) throw new Error('no durable store configured');

  console.log('\u25B6 Primitives');
  const k1 = key('value');
  await store.set(k1, 'hello', 60);
  record('set and get round-trip', (await store.get(k1)) === 'hello');

  await store.del(k1);
  record('delete removes the key', (await store.get(k1)) === null);

  const k2 = key('ttl');
  await store.set(k2, 'expires', 1);
  await sleep(1600);
  record('values expire on their TTL', (await store.get(k2)) === null);

  console.log('\n\u25B6 Counters, which are what quotas rely on');
  const k3 = key('counter');
  const counts = [];
  for (let i = 0; i < 3; i += 1) counts.push(await store.incrementWithTtl(k3, 60));
  record('increments are atomic and monotonic', JSON.stringify(counts) === '[1,2,3]', counts.join(','));

  const k4 = key('counter-ttl');
  await store.incrementWithTtl(k4, 1);
  await store.incrementWithTtl(k4, 1);
  await sleep(1600);
  // The expiry is set once, when the counter is created. Refreshing it on every
  // increment would turn a fixed window into a sliding one that never resets under load.
  record('counter window expires rather than sliding', (await store.get(k4)) === null);

  console.log('\n\u25B6 Sets, used for the egress allowlist');
  const k5 = key('set');
  await store.addToSet(k5, 'api.example.com', 60);
  await store.addToSet(k5, 'api.example.com', 60);
  await store.addToSet(k5, 'cdn.example.com', 60);
  const members = (await store.readSet(k5)).sort();
  record('sets deduplicate', JSON.stringify(members) === '["api.example.com","cdn.example.com"]', members.join(','));

  console.log('\n\u25B6 Quota enforcement');
  const subject = `selftest-subject-${suffix}`;
  let allowed = 0;
  let refusal = null;
  for (let i = 0; i < QUOTA_LIMITS.sandboxesPerHour + 2; i += 1) {
    const decision = await store.checkAndConsumeQuota(subject, QUOTA_LIMITS);
    if (decision.ok) allowed += 1;
    else refusal ??= decision;
  }
  keys.push(
    `quota:h:${subject}:${Math.floor(Date.now() / 3_600_000)}`,
    `quota:d:${subject}:${Math.floor(Date.now() / 86_400_000)}`,
  );
  record(
    `hourly quota stops at ${QUOTA_LIMITS.sandboxesPerHour}`,
    allowed === QUOTA_LIMITS.sandboxesPerHour,
    `${allowed} allowed`,
  );
  record('refusal explains itself and says when to retry', refusal?.reason === 'hourly_limit' && refusal.retryAfterSeconds > 0);

  console.log('\n\u25B6 Invite revocation');
  const code = `selftest-invite-${suffix}`;
  process.env.BUILDER_INVITE_CODES = code;
  record('a configured code is accepted', (await store.checkInvite(code)).ok);
  record('an unknown code is refused', (await store.checkInvite('definitely-not-a-code')).ok === false);

  await store.revokeInvite(code);
  const revoked = await store.checkInvite(code);
  keys.push(`invite:revoked:${(await import('node:crypto')).createHash('sha256').update(code).digest('hex')}`);
  record('revocation takes effect immediately', revoked.ok === false && revoked.reason === 'revoked');

  console.log('\n\u25B6 Kill switch');
  await store.setKillSwitch(true);
  record('kill switch engages', await store.isKillSwitchOn());
  await store.setKillSwitch(false);
  record('kill switch disengages', (await store.isKillSwitchOn()) === false);
} catch (err) {
  record('unexpected failure', false, err.message);
} finally {
  for (const k of keys) await store.del(k).catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}
