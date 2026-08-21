#!/usr/bin/env node
/**
 * Turn a published runtime image into a Mosaic environment and verify it boots.
 *
 * Environments are the builder's runtime because they are the only durable warm-start
 * Mosaic offers. A sandbox-derived snapshot keeps its Firecracker block device inside the
 * origin sandbox's runtime directory, so destroying the origin breaks every restore --
 * see scripts/mosaic-feasibility.mjs, check `snapshot-defect-still-present`. An
 * environment reports `source_sandbox_id: ""` and survives its children being destroyed.
 *
 *   node scripts/mosaic-build-environment.mjs --image ghcr.io/you/divij-builder-runtime:1.0.0
 *   node scripts/mosaic-build-environment.mjs --image ... --name builder-runtime-v1 --verify
 *   node scripts/mosaic-build-environment.mjs --list
 *
 * Prints the MOSAIC_ENVIRONMENT env var to set on the Vercel project when it finishes.
 */

import { resolveMosaicAuth } from './lib/mosaic-auth.mjs';

const DEFAULT_NAME = 'divij-builder-runtime';

const { token, endpoint, tokenSource } = resolveMosaicAuth();

async function api(method, path, body, timeoutMs = 900_000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: c.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { _raw: text };
    }
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const has = (flag) => process.argv.includes(flag);

async function list() {
  const { snapshots = [] } = await api('GET', '/v1/snapshots');
  if (!snapshots.length) {
    console.log('No environments or snapshots.');
    return;
  }
  console.log('name'.padEnd(34) + 'kind'.padEnd(12) + 'state'.padEnd(10) + 'source');
  for (const s of snapshots) {
    const kind = s.source_image ? 'environment' : 'snapshot';
    const source = s.source_image ? `${s.source_image} @ ${(s.source_image_digest || '').slice(0, 19)}` : `sandbox ${s.source_sandbox_id}`;
    console.log(
      String(s.name || s.id).padEnd(34) + kind.padEnd(12) + String(s.state).padEnd(10) + source,
    );
    if (kind === 'snapshot') {
      console.log('  '.padEnd(34) + 'WARNING: sandbox snapshots break once their origin is destroyed');
    }
  }
}

async function verify(name) {
  console.log('\nVerifying the environment boots and its containment holds:');
  const boots = [];
  let sandboxId = null;
  try {
    for (let i = 1; i <= 2; i += 1) {
      const t = Date.now();
      const sbx = await api('POST', '/v1/sandboxes', { snapshot_id: name, ttl_seconds: 900 });
      boots.push(Date.now() - t);
      console.log(`  boot ${i}: ${Date.now() - t}ms (${sbx.id})`);
      if (i === 2) {
        sandboxId = sbx.id;
      } else {
        await api('DELETE', `/v1/sandboxes/${sbx.id}`).catch(() => {});
      }
    }

    // A synchronous exec that runs for tens of seconds gets cut off by Mosaic's edge with
    // a Cloudflare 520, so anything slow runs as a durable process and is read back
    // through the log cursor. The control plane uses the same pattern for installs and
    // builds.
    console.log('  running builder-selftest inside the guest (durable process)...');
    const proc = await api('POST', `/v1/sandboxes/${sandboxId}/processes`, {
      argv: ['builder-selftest'],
      cwd: '/workspace',
    });

    let stdoutOffset = 0;
    let stderrOffset = 0;
    let output = '';
    let state = 'running';
    let exitCode = null;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const logs = await api(
        'GET',
        `/v1/sandboxes/${sandboxId}/processes/${proc.id}/logs?stdout_offset=${stdoutOffset}&stderr_offset=${stderrOffset}`,
        undefined,
        60_000,
      );
      output += (logs.stdout || '') + (logs.stderr || '');
      stdoutOffset = logs.next_stdout_offset ?? stdoutOffset;
      stderrOffset = logs.next_stderr_offset ?? stderrOffset;
      state = logs.state;
      if (state !== 'running') break;
      await sleep(1500);
    }
    if (state === 'running') throw new Error('builder-selftest did not finish within 300s');

    const status = await api('GET', `/v1/sandboxes/${sandboxId}/processes/${proc.id}`);
    exitCode = status.exit_code;
    for (const line of output.trim().split('\n')) console.log(`    ${line}`);
    if (exitCode !== 0) throw new Error(`builder-selftest failed with exit code ${exitCode}`);
    console.log('  selftest passed inside Mosaic');
  } finally {
    if (sandboxId) await api('DELETE', `/v1/sandboxes/${sandboxId}`).catch(() => {});
  }
  return boots;
}

async function main() {
  if (has('--list')) return list();

  const image = arg('--image');
  const name = arg('--name', DEFAULT_NAME);

  // Registry credentials are needed only while Mosaic converts the image. Once the
  // environment exists it is a self-contained snapshot, so booting from it never touches
  // the registry -- which is why the Vercel deployment needs no GHCR credentials.
  if (has('--verify-only')) {
    console.log(`Verifying existing environment "${name}" (auth from ${tokenSource})`);
    const boots = await verify(name);
    console.log(`\nBoot times: ${boots.join('ms, ')}ms`);
    return;
  }

  if (!image) {
    console.error(
      'usage: mosaic-build-environment.mjs --image <registry/image:tag> [--name <env-name>] [--verify] [--replace]\n' +
        '       mosaic-build-environment.mjs --verify-only [--name <env-name>]\n' +
        '       mosaic-build-environment.mjs --list',
    );
    process.exit(2);
  }

  if (has('--replace')) {
    await api('DELETE', `/v1/snapshots/${encodeURIComponent(name)}`)
      .then(() => console.log(`Deleted existing environment "${name}"`))
      .catch(() => {});
  }

  console.log(`Building environment "${name}" from ${image} (auth from ${tokenSource})`);
  console.log('(Mosaic pulls the image into a throwaway builder VM, boots it once, and keeps the result.)');
  const t0 = Date.now();
  const body = { image, name };
  const user = process.env.REGISTRY_USERNAME;
  const pass = process.env.REGISTRY_PASSWORD;
  if (user && pass) {
    // Used for this one pull inside the builder VM and discarded with it.
    body.registry_username = user;
    body.registry_password = pass;
    console.log('Using REGISTRY_USERNAME/REGISTRY_PASSWORD for a private pull.');
  }

  let op = await api('POST', '/v1/environments', body);
  while (op.status === 'pending' || op.status === 'running') {
    await sleep(3000);
    op = await api('GET', `/v1/operations/${op.id}`);
    process.stdout.write(`  ${op.status} (${Math.round((Date.now() - t0) / 1000)}s)   \r`);
  }
  console.log();

  if (op.status !== 'succeeded') {
    console.error(`Build ${op.status}: ${op.error || JSON.stringify(op).slice(0, 400)}`);
    if (/not found|unauthorized|denied/i.test(op.error || '')) {
      console.error(
        '\nThe image must be publicly pullable, or you must pass REGISTRY_USERNAME and\n' +
          'REGISTRY_PASSWORD. Mosaic also requires linux/amd64 and an image containing /bin/sh.',
      );
    }
    process.exit(1);
  }

  const env = op.environment;
  console.log(`Built in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`  id      ${env.id}`);
  console.log(`  name    ${env.name}`);
  console.log(`  digest  ${env.source_image_digest}`);
  console.log(`  shape   ${env.vcpu} vCPU / ${env.memory_mb} MB`);
  console.log(`  source_sandbox_id "${env.source_sandbox_id}" (empty: nothing can strand it)`);

  if (has('--verify')) {
    const boots = await verify(name);
    console.log(`\nBoot times: ${boots.join('ms, ')}ms`);
  }

  console.log('\nSet these on the Vercel project:');
  console.log(`  MOSAIC_ENVIRONMENT=${env.name}`);
  console.log(`  MOSAIC_RUNTIME_DIGEST=${env.source_image_digest}`);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
