#!/usr/bin/env node
/**
 * End-to-end test of the builder's HTTP control plane.
 *
 * Covers the one layer nothing else does. `scripts/e2e-sandbox.mjs` calls the tool
 * implementations directly, so it never exercises routing, the session cookie, origin
 * checks, path validation at the HTTP edge, or NDJSON framing over a real socket. Both
 * bugs this script has caught so far lived exactly there.
 *
 *   vercel dev --listen 4185          # in another terminal
 *   node scripts/e2e-api.mjs
 *   node scripts/e2e-api.mjs --base http://localhost:3000
 *
 * The invite code is read from .env (BUILDER_INVITE_CODES, first entry).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = arg('--base', 'http://localhost:4185').replace(/\/$/, '');
const ORIGIN = new URL(BASE).host;

function inviteCode() {
  if (process.env.BUILDER_INVITE_CODE) return process.env.BUILDER_INVITE_CODE;
  try {
    for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('BUILDER_INVITE_CODES=')) {
        return trimmed.slice('BUILDER_INVITE_CODES='.length).split(',')[0].trim();
      }
    }
  } catch {
    /* reported below */
  }
  throw new Error('No invite code. Set BUILDER_INVITE_CODES in .env or BUILDER_INVITE_CODE in the environment.');
}

const INVITE = inviteCode();
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

let cookie = '';

async function api(path, { method = 'GET', body, origin = ORIGIN, useCookie = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: `http://${origin}` } : {}),
      ...(useCookie && cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && useCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, json, headers: res.headers };
}

/** Run a tool over HTTP and return its parsed NDJSON events. */
async function tool(workspaceId, name, args) {
  const res = await fetch(`${BASE}/api/builder/workspaces/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://${ORIGIN}`, Cookie: cookie },
    body: JSON.stringify({ workspace_id: workspaceId, tool: name, args }),
  });
  const text = await res.text();
  const lines = text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { kind: 'unparseable', raw: l };
      }
    });
  return { res, lines, result: lines.find((l) => l.kind === 'result')?.data };
}

let workspaceId = null;

try {
  console.log(`\nTesting ${BASE}\n`);
  console.log('\u25B6 Auth');
  const anon = await api('/api/builder/auth');
  record('unauthenticated status reports false', anon.status === 200 && anon.json.authenticated === false);

  const badOrigin = await api('/api/builder/auth', {
    method: 'POST',
    body: { code: INVITE },
    origin: 'evil.example.com',
    useCookie: false,
  });
  record('cross-origin sign-in refused', badOrigin.status === 403, badOrigin.json?.error);

  const wrongCode = await api('/api/builder/auth', { method: 'POST', body: { code: 'not-a-real-code' } });
  record('wrong invite code refused', wrongCode.status === 403, wrongCode.json?.error);
  record(
    'refusal does not distinguish wrong from revoked',
    wrongCode.json?.message === 'That invite code is not valid.',
  );

  const signIn = await api('/api/builder/auth', { method: 'POST', body: { code: INVITE } });
  record('valid invite code signs in', signIn.status === 200, `store durable=${signIn.json?.durable_store}`);

  const rawCookie = signIn.headers.get('set-cookie') || '';
  record(
    'session cookie is HttpOnly, Secure, SameSite=Strict, __Host-',
    rawCookie.includes('HttpOnly') &&
      rawCookie.includes('Secure') &&
      rawCookie.includes('SameSite=Strict') &&
      rawCookie.startsWith('__Host-'),
  );
  record('cookie carries no invite plaintext', !rawCookie.includes(INVITE));
  record('authenticated status reports true', (await api('/api/builder/auth')).json?.authenticated === true);

  console.log('\n\u25B6 Authorization');
  record(
    'workspace creation requires a session',
    (await api('/api/builder/workspaces', { method: 'POST', useCookie: false })).status === 401,
  );
  const unknown = await api('/api/builder/workspaces?workspace_id=ws_notarealworkspaceid');
  record('unknown workspace id is rejected', unknown.status === 404, unknown.json?.error);
  const malformed = await api('/api/builder/workspaces?workspace_id=../../etc/passwd');
  record('malformed workspace id is rejected', malformed.status === 400, malformed.json?.error);

  console.log('\n\u25B6 Workspace lifecycle');
  const created = await api('/api/builder/workspaces', { method: 'POST' });
  record(
    'sandbox created through HTTP',
    created.status === 201 && typeof created.json?.workspace_id === 'string',
    created.json?.workspace_id ? `runtime ${created.json.runtime?.version}` : JSON.stringify(created.json).slice(0, 200),
  );
  workspaceId = created.json?.workspace_id ?? null;
  if (!workspaceId) throw new Error('cannot continue without a workspace');

  record(
    'response never leaks the Mosaic sandbox id',
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(JSON.stringify(created.json)),
  );
  record('containment reported as enforced', created.json.runtime?.containment === 'enforced');

  const status = await api(`/api/builder/workspaces?workspace_id=${workspaceId}`);
  record('workspace status readable', status.status === 200 && status.json?.state === 'running');
  // Regression guard: without Redis the store is cold on every invocation, so this value
  // only survives because it is recovered from the sandbox's own labels.
  record(
    'expiry survives a cold store',
    typeof status.json?.seconds_remaining === 'number' && status.json.seconds_remaining > 0,
    `${status.json?.seconds_remaining}s left`,
  );
  record('runtime report survives a cold store', status.json?.runtime?.containment === 'enforced');

  console.log('\n\u25B6 Tool streaming over NDJSON');
  const write = await tool(workspaceId, 'fs.write', {
    files: [{ path: 'hello.txt', content: 'written over http' }],
  });
  record('tool stream is NDJSON', (write.res.headers.get('content-type') || '').includes('ndjson'));
  record('events arrive in order ending with a result', write.lines.at(-1)?.kind === 'result');
  record('no-store header set on the tool route', (write.res.headers.get('cache-control') || '').includes('no-store'));

  const read = await tool(workspaceId, 'fs.read', { paths: ['hello.txt'] });
  record('file round-trips through the HTTP tool route', read.result?.files?.['hello.txt'] === 'written over http');

  const traversal = await tool(workspaceId, 'fs.write', {
    files: [{ path: '../../../etc/cron.d/pwn', content: 'x' }],
  });
  record(
    'server rejects traversal independently of the client',
    traversal.lines.some((l) => l.kind === 'error') || traversal.res.status === 400,
  );

  const unknownTool = await api('/api/builder/workspaces/tool', {
    method: 'POST',
    body: { workspace_id: workspaceId, tool: 'rm.rf', args: {} },
  });
  record('unknown tool name is rejected', unknownTool.status === 400, unknownTool.json?.error);

  console.log('\n\u25B6 Egress approval');
  record(
    'egress change without approval is refused',
    (await api('/api/builder/egress/allow', {
      method: 'POST',
      body: { workspace_id: workspaceId, hostname: 'api.example.com' },
    })).status === 403,
  );
  record(
    'metadata address cannot be allowlisted',
    (await api('/api/builder/egress/allow', {
      method: 'POST',
      body: { workspace_id: workspaceId, hostname: '169.254.169.254', approved: true },
    })).status === 400,
  );
  const approved = await api('/api/builder/egress/allow', {
    method: 'POST',
    body: { workspace_id: workspaceId, hostname: 'api.github.com', approved: true },
  });
  record('approved host is added', approved.status === 200 && approved.json?.hosts?.includes('api.github.com'));

  console.log('\n\u25B6 Model relay');
  const relay = async (preset, path) =>
    (
      await fetch(`${BASE}/api/builder/model/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: `http://${ORIGIN}`,
          Cookie: cookie,
          'X-Builder-Preset': preset,
          'X-Builder-Path': path,
          'X-Builder-Key': 'sk-fake-key-for-testing',
        },
        body: JSON.stringify({ model: 'x', messages: [] }),
      })
    ).status;

  record('relay refuses an unknown preset, so it cannot be aimed anywhere', (await relay('https://evil.example.com', '/v1/chat/completions')) === 400);
  record('relay refuses a path outside the preset allowlist', (await relay('openai', '/v1/files')) === 400);

  console.log('\n\u25B6 Teardown');
  const destroyed = await api('/api/builder/workspaces', { method: 'DELETE', body: { workspace_id: workspaceId } });
  record('workspace destroyed', destroyed.status === 200 && destroyed.json?.ok === true);
  // Regression guard for a leak: DELETE once returned already_gone from a cold store
  // without destroying anything, leaving a live sandbox billing for its full TTL.
  record('destroy actually acted rather than reporting already_gone', destroyed.json?.already_gone !== true);

  const after = await api(`/api/builder/workspaces?workspace_id=${workspaceId}`);
  record('destroyed workspace reports as gone', after.status === 404, after.json?.error);
  workspaceId = null;

  record('sign out succeeds', (await api('/api/builder/auth', { method: 'DELETE' })).status === 200);
} catch (err) {
  record('unexpected failure', false, err.message);
} finally {
  if (workspaceId) {
    await api('/api/builder/workspaces', { method: 'DELETE', body: { workspace_id: workspaceId } }).catch(() => {});
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}
