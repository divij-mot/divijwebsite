/**
 * Agent tool implementations, executed against a Mosaic sandbox.
 *
 * Every tool is a generator of NDJSON events so the browser can render output as it
 * arrives instead of waiting for a three-minute install to finish. Each yields
 * `{kind, seq, tool, ...}` lines; `result` is always last on success.
 *
 * Two invariants hold across all of them:
 *   - Paths are validated with `assertProjectPath` before touching the filesystem. The
 *     browser validates too, but a control plane that trusts its client is not a boundary.
 *   - Project commands run through `builder-run`, which drops to the unprivileged user and
 *     injects proxy credentials. Nothing here runs project code as root.
 */

import { AGENT_LIMITS, TIMEOUTS_MS, WORKSPACE_ROOT } from './limits.js';
import * as mosaic from './mosaic.js';
import { HttpError } from './session.js';
import { assertProjectPath, toGuestPath } from './validate.js';

/**
 * The browser helper runs inside the contained network namespace so it reaches the app
 * over loopback the way a real browser would. From the root namespace, where our exec
 * calls land, it is only reachable across the veth -- not on 127.0.0.1.
 */
const GUEST_IP = process.env.BUILDER_GUEST_IP || '10.200.0.2';
const BROWSER_ENDPOINT = `http://${GUEST_IP}:8124/act`;

/** Truncate model-visible output, always saying so rather than silently cutting. */
function cap(text, limit = AGENT_LIMITS.maxToolOutputBytes) {
  if (typeof text !== 'string') return text;
  if (Buffer.byteLength(text) <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(-Math.floor(limit * 0.2));
  const dropped = text.length - head.length - tail.length;
  return `${head}\n\n... [${dropped.toLocaleString()} characters omitted] ...\n\n${tail}`;
}

function emitter() {
  let seq = 0;
  return (tool, kind, payload = {}) => ({ kind, seq: seq++, tool, ...payload });
}

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

/**
 * `find` rather than a recursive files API walk: one guest command instead of N round
 * trips, and it can apply the exclusion rules inline.
 */
async function* fsTree(ctx, args) {
  const e = ctx.emit;
  yield e('fs.tree', 'start', { text: 'Listing project files' });
  const maxDepth = Math.min(Number(args.max_depth) || 12, 20);
  const cmd =
    `cd ${WORKSPACE_ROOT} 2>/dev/null && find . -maxdepth ${maxDepth} ` +
    `\\( -name node_modules -o -name .git -o -name .next -o -name dist -o -name build -o -name .turbo -o -name coverage \\) -prune -o ` +
    `-type f -print | sed 's|^\\./||' | sort | head -4000`;

  const r = await mosaic.exec(ctx.sandboxId, ['bash', '-lc', cmd], { timeoutMs: 20_000 });
  const files = r.stdout.split('\n').filter(Boolean);
  yield e('fs.tree', 'result', { data: { files, count: files.length, truncated: files.length >= 4000 } });
}

async function* fsRead(ctx, args) {
  const e = ctx.emit;
  const paths = (Array.isArray(args.paths) ? args.paths : [args.path]).filter(Boolean);
  if (!paths.length) throw new HttpError(400, 'invalid_args', 'fs.read needs at least one path.');
  if (paths.length > AGENT_LIMITS.maxFilesPerRead) {
    throw new HttpError(400, 'too_many_files', `Read at most ${AGENT_LIMITS.maxFilesPerRead} files at once.`);
  }

  yield e('fs.read', 'start', { text: `Reading ${paths.length} file(s)` });
  const files = {};
  for (const p of paths) {
    const rel = assertProjectPath(p);
    try {
      const content = await mosaic.readTextFile(ctx.sandboxId, toGuestPath(rel));
      files[rel] = cap(content, 60_000);
    } catch (err) {
      files[rel] = `<<error reading file: ${err.message.slice(0, 160)}>>`;
    }
  }
  yield e('fs.read', 'result', { data: { files } });
}

async function* fsSearch(ctx, args) {
  const e = ctx.emit;
  const query = String(args.query || '');
  if (!query) throw new HttpError(400, 'invalid_args', 'fs.search needs a query.');
  yield e('fs.search', 'start', { text: `Searching for ${query}` });

  // ripgrep respects .gitignore and skips binaries; -F unless the caller asked for regex.
  const flags = ['--line-number', '--no-heading', '--color=never', '--max-count=8', '--max-columns=300'];
  if (!args.regex) flags.push('--fixed-strings');
  if (args.glob) flags.push('--glob', String(args.glob));

  const r = await mosaic.exec(
    ctx.sandboxId,
    ['bash', '-lc', 'cd "$1" && rg "${@:3}" -- "$2" | head -300', '_', WORKSPACE_ROOT, query, ...flags],
    { timeoutMs: 25_000 },
  );
  const matches = r.stdout.split('\n').filter(Boolean);
  yield e('fs.search', 'result', { data: { matches, count: matches.length } });
}

async function* fsWrite(ctx, args) {
  const e = ctx.emit;
  const files = Array.isArray(args.files) ? args.files : [{ path: args.path, content: args.content }];
  if (!files.length) throw new HttpError(400, 'invalid_args', 'fs.write needs files.');

  const written = [];
  const refused = [];
  yield e('fs.write', 'start', { text: `Writing ${files.length} file(s)` });

  for (const f of files) {
    const rel = assertProjectPath(f.path);
    const content = String(f.content ?? '');

    // A refusal is reported in the result rather than as an `error` event. An error event
    // terminates the whole call, which would discard the other files in a batch write and
    // leave the model unsure what landed. Naming the refused file lets it fix just that one.
    if (looksLikeSecret(content)) {
      refused.push({
        path: rel,
        reason:
          'The content contains something shaped like a real credential. Read it from process.env instead and add the variable name to .env.example.',
      });
      yield e('fs.write', 'progress', { text: `refused ${rel} (looks like a credential)` });
      continue;
    }

    await mosaic.writeTextFile(ctx.sandboxId, toGuestPath(rel), content);
    written.push({ path: rel, bytes: Buffer.byteLength(content) });
    yield e('fs.write', 'progress', { text: rel });
  }

  yield e('fs.write', 'result', {
    data: {
      written,
      paths: written.map((w) => w.path),
      ...(refused.length ? { refused } : {}),
    },
  });
}

/**
 * Literal string replacement rather than a unified diff.
 *
 * Models produce malformed diff hunks often enough that applying them is a reliability
 * problem; an exact-match replacement either applies or fails loudly with the surrounding
 * context, which the model can act on.
 */
async function* fsPatch(ctx, args) {
  const e = ctx.emit;
  const rel = assertProjectPath(args.path);
  const edits = Array.isArray(args.edits) ? args.edits : [{ old: args.old, new: args.new }];
  yield e('fs.patch', 'start', { text: `Patching ${rel}` });

  const guestPath = toGuestPath(rel);
  let content;
  try {
    content = await mosaic.readTextFile(ctx.sandboxId, guestPath);
  } catch {
    throw new HttpError(404, 'file_not_found', `${rel} does not exist. Use fs.write to create it.`);
  }

  const applied = [];
  for (const [i, edit] of edits.entries()) {
    const oldText = String(edit.old ?? '');
    const newText = String(edit.new ?? '');
    if (!oldText) throw new HttpError(400, 'invalid_args', `Edit ${i + 1} has no text to replace.`);

    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      throw new HttpError(422, 'patch_no_match', `Edit ${i + 1} did not match ${rel}. Read the file again; it may have changed.`);
    }
    if (occurrences > 1 && !edit.replace_all) {
      throw new HttpError(
        422,
        'patch_ambiguous',
        `Edit ${i + 1} matches ${occurrences} places in ${rel}. Include more surrounding context, or set replace_all.`,
      );
    }
    content = edit.replace_all ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    applied.push({ index: i + 1, occurrences: edit.replace_all ? occurrences : 1 });
  }

  await mosaic.writeTextFile(ctx.sandboxId, guestPath, content);
  yield e('fs.patch', 'result', { data: { path: rel, edits: applied, bytes: Buffer.byteLength(content) } });
}

async function* fsMove(ctx, args) {
  const e = ctx.emit;
  const from = assertProjectPath(args.from);
  const to = assertProjectPath(args.to);
  yield e('fs.move', 'start', { text: `${from} -> ${to}` });
  await mosaic.moveFile(ctx.sandboxId, toGuestPath(from), toGuestPath(to));
  yield e('fs.move', 'result', { data: { from, to } });
}

/**
 * Deletes need confirmation when they are large or reach the project root, because an
 * agent that decides to "start clean" can otherwise destroy the sandbox copy of work the
 * user has not exported. The local OPFS tree is unaffected either way.
 */
async function* fsDelete(ctx, args) {
  const e = ctx.emit;
  const paths = (Array.isArray(args.paths) ? args.paths : [args.path]).filter(Boolean).map(assertProjectPath);
  if (!paths.length) throw new HttpError(400, 'invalid_args', 'fs.delete needs paths.');

  const rootLevel = paths.filter((p) => !p.includes('/'));
  const needsConfirmation =
    paths.length > AGENT_LIMITS.destructiveDeleteThreshold || rootLevel.length > 0;

  if (needsConfirmation && !args.confirmed) {
    yield e('fs.delete', 'confirm-required', {
      data: {
        reason:
          rootLevel.length > 0
            ? `This deletes ${rootLevel.length} item(s) at the project root: ${rootLevel.join(', ')}`
            : `This deletes ${paths.length} files at once.`,
        paths,
        action: 'fs.delete',
      },
    });
    return;
  }

  yield e('fs.delete', 'start', { text: `Deleting ${paths.length} path(s)` });
  const deleted = [];
  for (const p of paths) {
    await mosaic.deleteFile(ctx.sandboxId, toGuestPath(p), true).catch(() => {});
    deleted.push(p);
  }
  yield e('fs.delete', 'result', { data: { deleted } });
}

/** Heuristic guard against the model hardcoding a key it was shown or invented. */
function looksLikeSecret(content) {
  const patterns = [
    /\bsk-[A-Za-z0-9]{32,}\b/,
    /\bsk-proj-[A-Za-z0-9_-]{20,}\b/,
    /\bmsk_live_[A-Za-z0-9]{16,}\b/,
    /\bghp_[A-Za-z0-9]{36}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  return patterns.some((re) => re.test(content));
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Upload a batch of files from the browser's OPFS tree.
 *
 * This is the rehydration path: when a sandbox expires, the browser creates a new one and
 * replays its whole tree through here. Content arrives base64-encoded so binary assets
 * survive intact.
 */
async function* fsSync(ctx, args) {
  const e = ctx.emit;
  const files = Array.isArray(args.files) ? args.files : [];
  if (!files.length) throw new HttpError(400, 'invalid_args', 'fs.sync needs files.');

  yield e('fs.sync', 'start', { text: `Uploading ${files.length} file(s)` });
  let bytes = 0;
  const uploaded = [];
  for (const [i, f] of files.entries()) {
    const rel = assertProjectPath(f.path);
    const buffer = Buffer.from(String(f.content_base64 || ''), 'base64');
    bytes += buffer.length;
    await mosaic.writeLargeFile(ctx.sandboxId, toGuestPath(rel), buffer);
    uploaded.push(rel);
    if (i % 25 === 0 || i === files.length - 1) {
      yield e('fs.sync', 'progress', { text: `${i + 1}/${files.length}`, data: { done: i + 1, total: files.length } });
    }
  }

  for (const p of Array.isArray(args.delete) ? args.delete : []) {
    await mosaic.deleteFile(ctx.sandboxId, toGuestPath(assertProjectPath(p)), true).catch(() => {});
  }

  yield e('fs.sync', 'result', { data: { uploaded: uploaded.length, bytes } });
}

/**
 * Report which files changed in the guest since the last sync point, so the browser can
 * pull them back into OPFS.
 *
 * Git is the mechanism: `fs.sync` commits a baseline, and `git status --porcelain` after a
 * build or a shell command names exactly what moved. Without this, a `npx shadcn add`
 * would create files the browser never learns about, and they would vanish with the
 * sandbox.
 */
async function* fsChanges(ctx, args) {
  const e = ctx.emit;
  yield e('fs.changes', 'start', { text: 'Checking for changes made inside the sandbox' });

  const script = `
cd ${WORKSPACE_ROOT} || exit 0
if [ ! -d .git ]; then
  git init -q 2>/dev/null
  git config user.email builder@local 2>/dev/null
  git config user.name builder 2>/dev/null
fi
git add -A 2>/dev/null
git status --porcelain=v1 -uall 2>/dev/null | head -2000
`;
  const r = await mosaic.runAsBuilder(ctx.sandboxId, script, { timeoutMs: 60_000 });

  const changed = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim();
    let path = line.slice(3).trim();
    if (path.includes(' -> ')) path = path.split(' -> ')[1];
    path = path.replace(/^"|"$/g, '');
    // Dependencies and build output are regenerated, never mirrored back. Incremental
    // build state is excluded too: tsc and Next write it on every build, so mirroring it
    // adds a large, meaningless file to the project and to every export.
    if (/^(node_modules|\.next|dist|build|out|\.turbo|coverage|\.git)\//.test(path)) continue;
    if (/(^|\/)[^/]*\.tsbuildinfo$/.test(path)) continue;
    changed.push({ path, status: status === 'D' ? 'deleted' : status === 'A' ? 'added' : 'modified' });
  }

  const contents = {};
  if (args.include_content !== false) {
    for (const c of changed.slice(0, 200)) {
      if (c.status === 'deleted') continue;
      try {
        const buf = await mosaic.readFile(ctx.sandboxId, toGuestPath(c.path));
        contents[c.path] = buf.toString('base64');
      } catch {
        /* a file deleted between listing and reading is not an error */
      }
    }
  }

  // Commit so the next call reports only what changed after this point.
  await mosaic.runAsBuilder(ctx.sandboxId, `cd ${WORKSPACE_ROOT} && git add -A && git commit -q -m sync --allow-empty`, {
    timeoutMs: 45_000,
  }).catch(() => {});

  yield e('fs.changes', 'result', { data: { changed, contents, truncated: changed.length > 200 } });
}

// ---------------------------------------------------------------------------
// Shell and packages
// ---------------------------------------------------------------------------

async function* shellRun(ctx, args) {
  const e = ctx.emit;
  const command = String(args.command || '').trim();
  if (!command) throw new HttpError(400, 'invalid_args', 'shell.run needs a command.');
  if (command.length > 8000) throw new HttpError(400, 'command_too_long', 'Command is too long.');

  const timeoutMs = Math.min(Number(args.timeout_ms) || TIMEOUTS_MS.command, TIMEOUTS_MS.build);
  yield e('shell.run', 'start', { text: command.slice(0, 300) });

  const chunks = [];
  const result = await mosaic.runAsBuilder(ctx.sandboxId, command, {
    timeoutMs,
    cwd: args.cwd ? toGuestPath(assertProjectPath(args.cwd)) : WORKSPACE_ROOT,
    signal: ctx.signal,
    onOutput: (stream, text) => chunks.push({ stream, text }),
  });

  // runCommand buffers via onOutput; replay in order now that it finished.
  for (const c of chunks) yield e('shell.run', c.stream, { text: c.text });

  yield e('shell.run', 'result', {
    data: {
      exit_code: result.exitCode,
      timed_out: Boolean(result.timedOut),
      stdout: cap(result.stdout),
      stderr: cap(result.stderr),
    },
  });
}

/**
 * Package installation, kept separate from shell.run so it gets the longer timeout and so
 * a refused install produces a specific message about the egress allowlist rather than a
 * generic network error.
 */
async function* pkgInstall(ctx, args) {
  const e = ctx.emit;
  const packages = (Array.isArray(args.packages) ? args.packages : []).map(String);
  const manager = ['npm', 'pnpm', 'yarn', 'bun'].includes(args.manager) ? args.manager : 'npm';

  for (const p of packages) {
    // A package spec that is a URL or a git ref would fetch from an arbitrary host,
    // sidestepping the registry allowlist.
    if (!/^(@[a-z0-9-~][\w.-]*\/)?[a-z0-9-~][\w.-]*(@[\w.^~*>=<| -]+)?$/i.test(p)) {
      throw new HttpError(
        400,
        'invalid_package',
        `"${p}" is not a plain registry package name. URLs and git references are not installable here.`,
      );
    }
  }

  const command = packages.length
    ? `${manager} ${manager === 'npm' ? 'install' : 'add'} ${packages.join(' ')}`
    : `${manager} install`;

  yield e('pkg.install', 'start', { text: command });
  const chunks = [];
  const result = await mosaic.runAsBuilder(ctx.sandboxId, command, {
    timeoutMs: TIMEOUTS_MS.install,
    signal: ctx.signal,
    onOutput: (stream, text) => chunks.push({ stream, text }),
  });
  for (const c of chunks) yield e('pkg.install', c.stream, { text: c.text });

  const combined = result.stdout + result.stderr;
  const blocked = /403|host_not_allowed|CONNECT tunnel failed|ECONNREFUSED|ENOTFOUND/.test(combined);
  yield e('pkg.install', 'result', {
    data: {
      exit_code: result.exitCode,
      stdout: cap(result.stdout),
      stderr: cap(result.stderr),
      hint:
        result.exitCode !== 0 && blocked
          ? 'The install was blocked by the egress allowlist. If it needs a host other than the npm registry, ask the user to approve it.'
          : undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// Dev server
// ---------------------------------------------------------------------------

const DEV_PID_FILE = '/var/run/builder/dev.process';

async function* devStart(ctx, args) {
  const e = ctx.emit;
  const command = String(args.command || 'npm run dev -- -H 0.0.0.0 -p 3000');
  yield e('dev.start', 'start', { text: command });

  // Kill any previous dev server first; two servers racing for port 3000 produce a
  // confusing "address in use" that looks like a project bug.
  await mosaic
    .runAsBuilder(ctx.sandboxId, `pkill -f "next dev|vite|remix dev|nuxt dev" 2>/dev/null; sleep 1; true`, {
      timeoutMs: 20_000,
    })
    .catch(() => {});

  const proc = await mosaic.startProcess(
    ctx.sandboxId,
    ['builder-run', '--cwd', WORKSPACE_ROOT, '--', 'bash', '-lc', command],
    { cwd: '/workspace' },
  );
  await mosaic.exec(ctx.sandboxId, ['bash', '-lc', `echo "$1" > ${DEV_PID_FILE}`, '_', proc.id], {
    timeoutMs: 10_000,
  }).catch(() => {});

  // Poll the port forwarder in the root namespace: it answers only once the dev server
  // inside the namespace is actually listening, so this is both the earliest and the most
  // precise readiness signal, and it exercises the same path the preview will use.
  //
  // The probe prints a single sentinel line rather than relying on curl's own output.
  // `-w "%{http_code}"` still emits "000" on failure, so combining it with a fallback
  // echo produced "000000", which a naive "not 000" check read as success.
  let ready = false;
  let lastStatus = 'none';
  for (let i = 0; i < 60; i += 1) {
    const probe = await mosaic
      .exec(
        ctx.sandboxId,
        [
          'bash',
          '-lc',
          'code=$(curl -s -o /dev/null -w "%{http_code}" -m 3 http://127.0.0.1:3000/ 2>/dev/null); printf "STATUS:%s" "${code:-000}"',
        ],
        { timeoutMs: 12_000 },
      )
      .catch(() => ({ stdout: 'STATUS:000' }));

    const match = /STATUS:(\d{3})/.exec(probe.stdout || '');
    lastStatus = match ? match[1] : 'none';
    // Any HTTP response means the server is up; a 404 or 500 is the app's problem, not a
    // startup failure, and the agent should see the page rather than a timeout.
    if (match && lastStatus !== '000') {
      ready = true;
      break;
    }
    if (i % 5 === 0) yield e('dev.start', 'progress', { text: `waiting for the dev server (${i}s)` });
    await new Promise((r) => setTimeout(r, 1000));
  }

  const logs = await mosaic.readProcessLogs(ctx.sandboxId, proc.id, 0, 0).catch(() => ({ stdout: '', stderr: '' }));
  yield e('dev.start', 'result', {
    data: {
      process_id: proc.id,
      ready,
      http_status: lastStatus,
      logs: cap((logs.stdout || '') + (logs.stderr || ''), 20_000),
    },
  });
}

async function* devLogs(ctx, args) {
  const e = ctx.emit;
  const processId = String(args.process_id || '');
  if (!processId) throw new HttpError(400, 'invalid_args', 'dev.logs needs process_id.');
  const logs = await mosaic.readProcessLogs(
    ctx.sandboxId,
    processId,
    Number(args.stdout_offset) || 0,
    Number(args.stderr_offset) || 0,
  );
  yield e('dev.logs', 'result', {
    data: {
      stdout: cap(logs.stdout || '', 60_000),
      stderr: cap(logs.stderr || '', 60_000),
      next_stdout_offset: logs.next_stdout_offset,
      next_stderr_offset: logs.next_stderr_offset,
      state: logs.state,
    },
  });
}

async function* devStatus(ctx) {
  const e = ctx.emit;
  const r = await mosaic.exec(
    ctx.sandboxId,
    [
      'bash',
      '-lc',
      'echo "http=$(curl -s -o /dev/null -w %{http_code} -m 3 http://127.0.0.1:3000/ || echo 000)"; ' +
        'echo "browser=$(curl -s -o /dev/null -w %{http_code} -m 3 http://127.0.0.1:8124/health || echo 000)"; ' +
        'cat /var/run/builder/init.json 2>/dev/null || echo "{}"',
    ],
    { timeoutMs: 15_000 },
  );
  yield e('dev.status', 'result', { data: { report: r.stdout.trim() } });
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/**
 * Proxy an action to the in-guest Playwright helper.
 *
 * Tests run against http://127.0.0.1:3000 inside the same sandbox, so verification never
 * depends on the public preview being reachable and never exposes the app publicly just to
 * be tested.
 */
async function* browserAct(ctx, args) {
  const e = ctx.emit;
  const action = String(args.action || '');
  const allowed = new Set([
    'navigate', 'snapshot', 'screenshot', 'click', 'fill', 'press',
    'resize', 'wait_for', 'console_logs', 'network_failures', 'inspect', 'reset',
  ]);
  if (!allowed.has(action)) {
    throw new HttpError(400, 'unknown_browser_action', `Unsupported browser action "${action}".`);
  }

  const payload = { ...args };
  if (action === 'navigate') {
    // Only the app under test is reachable; the browser is not a general web client.
    const url = String(args.url || 'http://127.0.0.1:3000/');
    let parsed;
    try {
      parsed = new URL(url, 'http://127.0.0.1:3000/');
    } catch {
      throw new HttpError(400, 'invalid_url', 'Malformed URL.');
    }
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      throw new HttpError(
        403,
        'external_navigation_blocked',
        'The test browser can only visit the app running in this sandbox.',
      );
    }
    payload.url = parsed.toString();
  }

  yield e('browser', 'start', { text: `browser.${action}` });

  const body = JSON.stringify(payload).replace(/'/g, `'\\''`);
  const r = await mosaic.exec(
    ctx.sandboxId,
    [
      'bash',
      '-lc',
      `curl -sS -m ${Math.round(TIMEOUTS_MS.browserAction / 1000)} -X POST ${BROWSER_ENDPOINT} -H 'content-type: application/json' -d '${body}'`,
    ],
    { timeoutMs: TIMEOUTS_MS.browserAction + 10_000 },
  );

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new HttpError(
      502,
      'browser_helper_unavailable',
      `The in-sandbox browser did not respond: ${(r.stderr || r.stdout).slice(0, 200)}`,
    );
  }

  // A screenshot is returned to the caller for this one turn and never persisted.
  if (parsed.image_base64) {
    yield e('browser', 'result', {
      data: { ...parsed, image_base64: parsed.image_base64, ephemeral_image: true },
    });
    return;
  }
  yield e('browser', 'result', { data: parsed });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Typecheck then build. Run together because a type error surfaces faster and more
 * legibly than the same problem emerging from a bundler.
 */
async function* verifyBuild(ctx, args) {
  const e = ctx.emit;
  const typecheck = args.typecheck === undefined ? 'npx tsc --noEmit' : args.typecheck;
  const build = String(args.build || 'npm run build');

  const steps = [];
  if (typecheck) {
    yield e('verify.build', 'start', { text: typecheck });
    const r = await mosaic.runAsBuilder(ctx.sandboxId, typecheck, {
      timeoutMs: TIMEOUTS_MS.build,
      signal: ctx.signal,
    });
    steps.push({ step: 'typecheck', exit_code: r.exitCode, output: cap(r.stdout + r.stderr, 40_000) });
    if (r.exitCode !== 0) {
      yield e('verify.build', 'result', { data: { ok: false, steps } });
      return;
    }
  }

  yield e('verify.build', 'start', { text: build });
  const chunks = [];
  const r = await mosaic.runAsBuilder(ctx.sandboxId, build, {
    timeoutMs: TIMEOUTS_MS.build,
    signal: ctx.signal,
    onOutput: (stream, text) => chunks.push({ stream, text }),
  });
  for (const c of chunks) yield e('verify.build', c.stream, { text: c.text });
  steps.push({ step: 'build', exit_code: r.exitCode, output: cap(r.stdout + r.stderr, 60_000) });

  yield e('verify.build', 'result', { data: { ok: r.exitCode === 0, steps } });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOLS = {
  'fs.tree': fsTree,
  'fs.read': fsRead,
  'fs.search': fsSearch,
  'fs.write': fsWrite,
  'fs.patch': fsPatch,
  'fs.move': fsMove,
  'fs.delete': fsDelete,
  'fs.sync': fsSync,
  'fs.changes': fsChanges,
  'shell.run': shellRun,
  'pkg.install': pkgInstall,
  'dev.start': devStart,
  'dev.logs': devLogs,
  'dev.status': devStatus,
  browser: browserAct,
  'verify.build': verifyBuild,
};

export function createContext(sandboxId, signal) {
  return { sandboxId, signal, emit: emitter() };
}
