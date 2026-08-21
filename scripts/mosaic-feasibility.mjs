#!/usr/bin/env node
/**
 * Milestone 1 feasibility gate from PLAN.md section 1.
 *
 * Exercises the Mosaic Sandbox REST surface the builder control plane depends on
 * and prints a pass/fail table. Run before trusting any builder milestone:
 *
 *   node scripts/mosaic-feasibility.mjs
 *   node scripts/mosaic-feasibility.mjs --only snapshot-roundtrip
 *   node scripts/mosaic-feasibility.mjs --keep     # leave sandboxes alive for inspection
 *
 * The token is read from MOSAIC_API_TOKEN or the `mos` CLI config and is never printed.
 */

import { resolveMosaicAuth } from './lib/mosaic-auth.mjs';

const TEMPLATE = process.env.MOSAIC_TEMPLATE || 'node-22';

const { token, endpoint, tokenSource } = resolveMosaicAuth();

async function api(method, path, body, { raw = false, timeoutMs = 180_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${endpoint}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (raw) return res;
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const created = new Set();
const snapshots = new Set();

async function createSandbox(opts = {}) {
  const sbx = await api('POST', '/v1/sandboxes', {
    template: TEMPLATE,
    memory_mb: 4096,
    vcpu: 2,
    ttl_seconds: 1800,
    ...opts,
  });
  created.add(sbx.id);
  return sbx;
}

async function destroySandbox(id) {
  try {
    await api('DELETE', `/v1/sandboxes/${id}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  created.delete(id);
}

const writeFile = (id, path, content) =>
  api('PUT', `/v1/sandboxes/${id}/files/content`, {
    path,
    content_base64: b64(content),
    create_parents: true,
  });

async function readFile(id, path) {
  const r = await api('GET', `/v1/sandboxes/${id}/files/content?path=${encodeURIComponent(path)}`);
  return unb64(r.content_base64);
}

const exec = (id, argv, extra = {}) =>
  api('POST', `/v1/sandboxes/${id}/exec`, { argv, timeout_ms: 120_000, ...extra });

const sh = (id, cmd, extra = {}) => exec(id, ['bash', '-lc', cmd], extra);

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('identity', async (log) => {
  const who = await api('GET', '/v1/whoami');
  log(`org ${who.organization_id ?? who.organization ?? '?'} scopes=${(who.scopes || []).join(',')}`);
  const limits = await api('GET', '/v1/limits');
  log(`region ${limits.region}; templates ${(limits.templates || []).map((t) => t.id).join(',')}`);
  if (!(limits.templates || []).some((t) => t.id === TEMPLATE && t.creatable)) {
    throw new Error(`template ${TEMPLATE} is not creatable`);
  }
});

check('create-exec-destroy', async (log) => {
  const t0 = Date.now();
  const sbx = await createSandbox();
  log(`created ${sbx.id} in ${Date.now() - t0}ms (tti ${Math.round(sbx.tti_ms)}ms)`);
  const r = await exec(sbx.id, ['node', '-v']);
  log(`node ${r.stdout.trim()} exit=${r.exit_code}`);
  if (r.exit_code !== 0) throw new Error('node -v failed');
  await destroySandbox(sbx.id);
  log('destroyed');
});

check('file-io', async (log) => {
  const sbx = await createSandbox();
  const payload = 'x'.repeat(64 * 1024) + '\nÜñïçø∂é ✓\n';
  await writeFile(sbx.id, '/workspace/project/deep/nested/file.txt', payload);
  const back = await readFile(sbx.id, '/workspace/project/deep/nested/file.txt');
  if (back !== payload) throw new Error('round-trip mismatch');
  log(`round-tripped ${payload.length} bytes incl. unicode`);

  const listing = await api(
    'GET',
    `/v1/sandboxes/${sbx.id}/files?path=${encodeURIComponent('/workspace/project/deep')}`,
  );
  log(`list -> ${(listing.entries || []).map((e) => `${e.name}:${e.kind}`).join(', ')}`);

  await api('POST', `/v1/sandboxes/${sbx.id}/files/move`, {
    source: '/workspace/project/deep/nested/file.txt',
    destination: '/workspace/project/moved.txt',
    overwrite: true,
  });
  await readFile(sbx.id, '/workspace/project/moved.txt');
  log('move ok');

  await api(
    'DELETE',
    `/v1/sandboxes/${sbx.id}/files/content?path=${encodeURIComponent('/workspace/project/moved.txt')}`,
  );
  let deleted = false;
  try {
    await readFile(sbx.id, '/workspace/project/moved.txt');
  } catch {
    deleted = true;
  }
  if (!deleted) throw new Error('delete did not remove the file');
  log('delete ok');
  await destroySandbox(sbx.id);
});

check('chunked-upload', async (log) => {
  // Files API caps a single write at 8 MiB; the builder chunks larger assets
  // through base64 appends. Prove the reassembly path works.
  const sbx = await createSandbox();
  const chunk = Buffer.alloc(3 * 1024 * 1024, 0xab);
  const parts = 3;
  for (let i = 0; i < parts; i += 1) {
    await api('PUT', `/v1/sandboxes/${sbx.id}/files/content`, {
      path: `/workspace/.upload/part.${i}`,
      content_base64: chunk.toString('base64'),
      create_parents: true,
    });
  }
  const r = await sh(
    sbx.id,
    'cat /workspace/.upload/part.* > /workspace/big.bin && stat -c %s /workspace/big.bin && md5sum /workspace/big.bin',
  );
  const [sizeLine] = r.stdout.trim().split('\n');
  const expected = chunk.length * parts;
  log(`reassembled ${sizeLine} bytes (expected ${expected})`);
  if (Number(sizeLine) !== expected) throw new Error('chunk reassembly size mismatch');
  await destroySandbox(sbx.id);
});

check('durable-process-and-log-cursor', async (log) => {
  const sbx = await createSandbox();
  const proc = await api('POST', `/v1/sandboxes/${sbx.id}/processes`, {
    argv: ['bash', '-lc', 'for i in $(seq 1 20); do echo "line-$i"; sleep 0.2; done; echo DONE'],
    cwd: '/workspace',
  });
  log(`process ${proc.id} state=${proc.state}`);

  let stdoutOffset = 0;
  let collected = '';
  const deadline = Date.now() + 30_000;
  let state = proc.state;
  while (Date.now() < deadline) {
    const logs = await api(
      'GET',
      `/v1/sandboxes/${sbx.id}/processes/${proc.id}/logs?stdout_offset=${stdoutOffset}&stderr_offset=0`,
    );
    collected += logs.stdout || '';
    stdoutOffset = logs.next_stdout_offset ?? stdoutOffset;
    state = logs.state;
    if (collected.includes('DONE')) break;
    await sleep(400);
  }
  const lines = collected.split('\n').filter((l) => l.startsWith('line-'));
  log(`cursor collected ${lines.length}/20 lines, final state=${state}`);
  if (lines.length !== 20) throw new Error(`log cursor lost lines: got ${lines.length}`);
  await destroySandbox(sbx.id);
});

check('dev-server-preview', async (log) => {
  const sbx = await createSandbox();
  await writeFile(
    sbx.id,
    '/workspace/project/server.mjs',
    `import { createServer } from 'node:http';
createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>mosaic-probe</title><h1>mosaic-probe ' + req.url + '</h1>');
}).listen(3000, '0.0.0.0', () => console.log('listening on 3000'));
`,
  );
  const proc = await api('POST', `/v1/sandboxes/${sbx.id}/processes`, {
    argv: ['node', 'server.mjs'],
    cwd: '/workspace/project',
  });
  log(`dev process ${proc.id}`);

  // Loopback reachability (this is how Playwright will hit it).
  let local = null;
  for (let i = 0; i < 20; i += 1) {
    const r = await sh(sbx.id, 'curl -sS -m 3 http://127.0.0.1:3000/health || true');
    if (r.stdout.includes('mosaic-probe')) {
      local = r.stdout;
      break;
    }
    await sleep(500);
  }
  if (!local) throw new Error('dev server never answered on 127.0.0.1:3000');
  log('loopback reachable');

  const preview = await api('POST', `/v1/sandboxes/${sbx.id}/previews`, {
    port: 3000,
    expires_in_seconds: 900,
  });
  log(`preview ${preview.id} -> ${preview.url}`);

  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    const r = await api('GET', `/v1/sandboxes/${sbx.id}/previews/${preview.id}/ready`);
    if (r.ready) {
      ready = true;
      break;
    }
    await sleep(1000);
  }
  if (!ready) throw new Error('preview never became ready');
  log('preview ready');

  const res = await fetch(preview.url, { redirect: 'follow' });
  const html = await res.text();
  log(`public GET ${res.status}, ${html.length} bytes`);
  if (!html.includes('mosaic-probe')) throw new Error('preview did not serve guest content');

  await api('DELETE', `/v1/sandboxes/${sbx.id}/previews/${preview.id}`);
  await sleep(2000);
  const after = await fetch(preview.url, { redirect: 'follow' }).catch(() => null);
  const revoked = !after || !(await after.text()).includes('mosaic-probe');
  log(`revocation ${revoked ? 'enforced' : 'NOT ENFORCED'} (status ${after ? after.status : 'network error'})`);
  if (!revoked) throw new Error('revoked preview still serving content');

  await destroySandbox(sbx.id);
});

check('idle-wake', async (log) => {
  const sbx = await createSandbox();
  await writeFile(sbx.id, '/workspace/wake.txt', 'before-hibernation');
  log('sleeping 20s past the 3s idle-hibernation threshold');
  await sleep(20_000);
  const info = await api('GET', `/v1/sandboxes/${sbx.id}`);
  log(`state before touch: ${info.state}${info.state_detail ? ` (${info.state_detail})` : ''}`);
  const t0 = Date.now();
  const content = await readFile(sbx.id, '/workspace/wake.txt');
  log(`woke and read in ${Date.now() - t0}ms: "${content}"`);
  if (content !== 'before-hibernation') throw new Error('workspace lost across hibernation');
  const r = await exec(sbx.id, ['node', '-v']);
  if (r.exit_code !== 0) throw new Error('exec after wake failed');
  log('exec after wake ok');
  await destroySandbox(sbx.id);
});

/**
 * Regression guard for the defect that shaped this architecture.
 *
 * A sandbox-derived snapshot records its Firecracker block device inside the
 * ORIGIN sandbox's runtime directory (/var/lib/mar/runtime/mar-<origin-id>/).
 * Destroying the origin deletes that backing file. The snapshot metadata still
 * reports state:"ready", but any restore fails with:
 *
 *   Block: Virtio backend error: Error manipulating the backing file:
 *   No such file or directory (os error 2)
 *
 * So /v1/sandboxes/{id}/snapshots is NOT durable storage and the builder never
 * uses it. This check passes when the defect is still present so we notice if
 * Mosaic fixes it; flip EXPECT_SNAPSHOT_DEFECT once they do.
 */
const EXPECT_SNAPSHOT_DEFECT = true;

check('snapshot-defect-still-present', async (log) => {
  const name = `builder-feasibility-${Date.now()}`;
  const marker = `marker-${name}`;

  const origin = await createSandbox();
  log(`origin ${origin.id}`);
  await writeFile(origin.id, '/workspace/project/marker.txt', marker);

  const snap = await api('POST', `/v1/sandboxes/${origin.id}/snapshots`, { name, retention_seconds: 3600 });
  const snapId = snap.id || snap.snapshot_id || name;
  snapshots.add(snapId);
  log(`snapshot ${snapId} state=${snap.state ?? 'n/a'}`);

  let aliveOk = false;
  try {
    const childA = await createSandbox({ snapshot_id: name, template: undefined });
    aliveOk = (await readFile(childA.id, '/workspace/project/marker.txt')) === marker;
    log(`restore while origin alive: ${aliveOk ? 'OK' : 'MISMATCH'}`);
    await destroySandbox(childA.id);
  } catch (e) {
    log(`restore while origin alive: FAILED -> ${e.message.slice(0, 160)}`);
  }

  await destroySandbox(origin.id);
  await sleep(3000);
  const info = await api('GET', `/v1/snapshots/${encodeURIComponent(snapId)}`).catch((e) => ({ _error: e.message }));
  log(`metadata after origin destroy: state=${info.state ?? 'gone'} (metadata survives the data)`);

  let deadOk = false;
  let deadErr = '';
  try {
    const childB = await createSandbox({ snapshot_id: name, template: undefined });
    deadOk = (await readFile(childB.id, '/workspace/project/marker.txt')) === marker;
    await destroySandbox(childB.id);
  } catch (e) {
    deadErr = e.message;
  }
  log(`restore after origin destroy: ${deadOk ? 'OK' : `FAILED -> ${deadErr.slice(0, 200)}`}`);

  await api('DELETE', `/v1/snapshots/${encodeURIComponent(snapId)}`).catch(() => {});
  snapshots.delete(snapId);

  if (EXPECT_SNAPSHOT_DEFECT) {
    if (deadOk) {
      throw new Error(
        'Mosaic appears to have FIXED snapshot durability. Set EXPECT_SNAPSHOT_DEFECT=false; ' +
          'sandbox snapshots are now a viable warm-start path.',
      );
    }
    log('defect reproduced as expected -- builder correctly avoids sandbox snapshots');
    if (!aliveOk) log('NOTE: restore also failed with the origin alive, which is worse than recorded');
    return;
  }
  if (!deadOk) throw new Error(`snapshot restore after origin destroy failed: ${deadErr}`);
});

/**
 * The durable alternative: a container image built into a Mosaic environment.
 * `source_sandbox_id` comes back empty, so there is no origin sandbox whose
 * deletion can strand the backing file. This is what the builder runtime uses.
 */
check('environment-durability', async (log) => {
  const image = process.env.MOSAIC_PROBE_IMAGE || 'node:22-bookworm-slim';
  const name = `builder-envprobe-${Date.now()}`;
  const t0 = Date.now();

  let op = await api('POST', '/v1/environments', { image, name, retention_seconds: 3600 });
  while (op.status === 'pending' || op.status === 'running') {
    await sleep(3000);
    op = await api('GET', `/v1/operations/${op.id}`);
  }
  if (op.status !== 'succeeded') throw new Error(`environment build ${op.status}: ${op.error}`);
  snapshots.add(op.environment.id);
  log(`built ${image} in ${Math.round((Date.now() - t0) / 1000)}s`);
  log(`digest ${op.environment.source_image_digest}`);
  log(`source_sandbox_id="${op.environment.source_sandbox_id}" (empty means nothing can strand it)`);

  const boots = [];
  for (let i = 1; i <= 3; i += 1) {
    const t = Date.now();
    const sbx = await createSandbox({ snapshot_id: name, template: undefined });
    const r = await exec(sbx.id, ['node', '-v']);
    boots.push(Date.now() - t);
    log(`boot ${i}: ${Date.now() - t}ms, node ${r.stdout.trim()}`);
    await destroySandbox(sbx.id); // destroying children must not damage the environment
  }
  log(`three boots with destroys in between: ${boots.join('ms, ')}ms`);

  await api('DELETE', `/v1/snapshots/${encodeURIComponent(op.environment.id)}`).catch(() => {});
  snapshots.delete(op.environment.id);
});

check('ttl-destruction', async (log) => {
  const sbx = await createSandbox({ ttl_seconds: 60 });
  log(`created ${sbx.id} with ttl_seconds=60`);
  const moved = await api('POST', `/v1/sandboxes/${sbx.id}/timeout`, { ttl_seconds: 1800 });
  log(`timeout extended -> ${JSON.stringify(moved).slice(0, 200)}`);
  await destroySandbox(sbx.id);
  let gone = false;
  try {
    const info = await api('GET', `/v1/sandboxes/${sbx.id}`);
    gone = info.state === 'destroyed';
  } catch (e) {
    gone = e.status === 404;
  }
  log(`post-destroy addressable: ${gone ? 'no (correct)' : 'yes'}`);
  if (!gone) throw new Error('destroyed sandbox still reports a live state');
});

check('egress-posture', async (log) => {
  const sbx = await createSandbox();
  const registry = await sh(
    sbx.id,
    'curl -sS -o /dev/null -w "%{http_code}" -m 20 https://registry.npmjs.org/-/ping || echo FAILED',
  );
  log(`npm registry -> ${registry.stdout.trim()}`);

  const metadata = await sh(
    sbx.id,
    'curl -sS -m 5 -o /dev/null -w "%{http_code}" http://169.254.169.254/latest/meta-data/ 2>&1 || echo BLOCKED',
  );
  log(`cloud metadata 169.254.169.254 -> ${metadata.stdout.trim()}`);

  const priv = await sh(
    sbx.id,
    'curl -sS -m 5 -o /dev/null -w "%{http_code}" http://10.0.0.1/ 2>&1 || echo BLOCKED',
  );
  log(`private 10.0.0.1 -> ${priv.stdout.trim()}`);

  const nft = await sh(sbx.id, 'command -v nft iptables 2>&1 || echo none');
  log(`firewall tooling: ${nft.stdout.trim().replace(/\n/g, ' ') || 'none'}`);

  const whoami = await sh(sbx.id, 'id -un; id -u');
  log(`guest identity: ${whoami.stdout.trim().replace(/\n/g, ' uid=')}`);
  await destroySandbox(sbx.id);
});

check('rehydrate-after-loss', async (log) => {
  // Acceptance scenario 3: destroyed sandbox is rebuilt from the local tree.
  const tree = {
    'package.json': '{"name":"rehydrate-probe","private":true,"type":"module"}\n',
    'app/page.tsx': 'export default function Page() { return <h1>hi</h1>; }\n',
    'public/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  };

  const first = await createSandbox();
  for (const [p, c] of Object.entries(tree)) {
    await writeFile(first.id, `/workspace/project/${p}`, c);
  }
  const beforeHash = (
    await sh(first.id, 'cd /workspace/project && find . -type f | sort | xargs md5sum | md5sum')
  ).stdout.trim();
  log(`tree hash before loss: ${beforeHash}`);
  await destroySandbox(first.id);

  const second = await createSandbox();
  for (const [p, c] of Object.entries(tree)) {
    await writeFile(second.id, `/workspace/project/${p}`, c);
  }
  const afterHash = (
    await sh(second.id, 'cd /workspace/project && find . -type f | sort | xargs md5sum | md5sum')
  ).stdout.trim();
  log(`tree hash after rehydration: ${afterHash}`);
  if (beforeHash !== afterHash) throw new Error('rehydrated tree differs from the original');
  await destroySandbox(second.id);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes('--keep');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
  const selected = only ? checks.filter((c) => c.name === only) : checks;
  if (!selected.length) {
    console.error(`No check named "${only}". Available: ${checks.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }

  console.log(`Mosaic feasibility gate -> ${endpoint} (template ${TEMPLATE}, auth from ${tokenSource})\n`);
  const results = [];
  for (const c of selected) {
    const lines = [];
    const log = (m) => {
      lines.push(m);
      console.log(`    ${m}`);
    };
    const t0 = Date.now();
    console.log(`\u25B6 ${c.name}`);
    try {
      await c.fn(log);
      const ms = Date.now() - t0;
      results.push({ name: c.name, ok: true, ms });
      console.log(`  PASS (${ms}ms)\n`);
    } catch (e) {
      const ms = Date.now() - t0;
      results.push({ name: c.name, ok: false, ms, error: e.message });
      console.log(`  FAIL (${ms}ms): ${e.message}\n`);
    }
  }

  if (!keep) {
    for (const id of [...created]) await destroySandbox(id).catch(() => {});
    for (const s of [...snapshots]) {
      await api('DELETE', `/v1/snapshots/${encodeURIComponent(s)}`).catch(() => {});
    }
  } else if (created.size) {
    console.log(`Kept sandboxes: ${[...created].join(', ')}`);
  }

  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(32)} ${String(r.ms).padStart(7)}ms${r.error ? `  ${r.error}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('fatal:', e);
  for (const id of [...created]) await destroySandbox(id).catch(() => {});
  process.exit(1);
});
