/**
 * Mosaic Sandbox client for the control plane.
 *
 * Two behaviours here exist because of things measured against the live service rather
 * than read in the docs:
 *
 *  1. `POST /v1/sandboxes/{id}/snapshots` is never called. A sandbox-derived snapshot
 *     stores its Firecracker block device inside the origin sandbox's runtime directory,
 *     so destroying the origin breaks every restore while the snapshot still reports
 *     state "ready". Container-image environments have no origin and are used instead.
 *     Reproduced by scripts/mosaic-feasibility.mjs.
 *
 *  2. Long synchronous execs die at the edge with a Cloudflare 5xx. Anything slow goes
 *     through the durable process API, which also gives us the log cursor the UI needs.
 *
 * The API key is read from the environment on every call and is never returned to the
 * browser, logged, or written into the guest.
 */

import { MAX_SYNCHRONOUS_EXEC_MS, SANDBOX_LIMITS, WORKSPACE_ROOT } from './limits.js';

const DEFAULT_ENDPOINT = 'https://sandbox.mosaicos.com';

export class MosaicError extends Error {
  constructor(message, { status, code, requestId, retryable } = {}) {
    super(message);
    this.name = 'MosaicError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryable = Boolean(retryable);
  }
}

function config() {
  const token =
    process.env.MOSAIC_API_KEY || process.env.MOSAIC_API_TOKEN || process.env.MAR_API_TOKEN;
  if (!token) {
    throw new MosaicError('MOSAIC_API_KEY is not configured on this deployment.', { status: 503 });
  }
  return {
    token,
    endpoint: process.env.MOSAIC_API_URL || DEFAULT_ENDPOINT,
    environment: process.env.MOSAIC_ENVIRONMENT || 'divij-builder-runtime',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One HTTP call with retry for transient failures.
 *
 * Mosaic's runtime goes degraded independently of its edge; during one observed window
 * /healthz reported "runtime":"degraded" and every create returned a Cloudflare 502.
 * Retrying 502/503/504/520-599 with backoff turns most of those into a slow success
 * instead of a user-visible error.
 */
async function request(method, path, body, { timeoutMs = 120_000, retries = 3, raw = false } = {}) {
  const { token, endpoint } = config();
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (raw) return res;

      const text = await res.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }

      if (res.ok) return json;

      const retryable = res.status === 429 || res.status >= 500;
      const err = new MosaicError(
        json?.message || json?.error || `Mosaic ${method} ${path} failed with ${res.status}`,
        {
          status: res.status,
          code: json?.error,
          requestId: json?.request_id,
          retryable,
        },
      );
      if (!retryable || attempt === retries) throw err;
      lastError = err;
    } catch (err) {
      if (err instanceof MosaicError) {
        if (!err.retryable || attempt === retries) throw err;
        lastError = err;
      } else if (err.name === 'AbortError') {
        throw new MosaicError(`Mosaic ${method} ${path} timed out after ${timeoutMs}ms`, {
          status: 504,
          retryable: true,
        });
      } else {
        if (attempt === retries) throw new MosaicError(`Mosaic ${method} ${path}: ${err.message}`, { status: 502 });
        lastError = err;
      }
    } finally {
      clearTimeout(timer);
    }
    await sleep(Math.min(500 * 2 ** attempt, 4000));
  }
  throw lastError;
}

const b64encode = (input) =>
  Buffer.from(typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64');

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a sandbox from the builder runtime environment.
 *
 * `persist: false` and a two-hour TTL: the guest is disposable and the browser holds the
 * only durable copy of the project. Labels let a restarted control plane find an existing
 * sandbox without a database.
 */
export async function createSandbox({ labels = {}, ttlSeconds = SANDBOX_LIMITS.ttlSeconds } = {}) {
  const { environment } = config();
  const sandbox = await request(
    'POST',
    '/v1/sandboxes',
    {
      snapshot_id: environment,
      ttl_seconds: ttlSeconds,
      persist: false,
      network_enabled: true,
      enable_ssh: false,
      metadata: labels,
    },
    { timeoutMs: 120_000 },
  );
  return sandbox;
}

export function getSandbox(id) {
  return request('GET', `/v1/sandboxes/${id}`, undefined, { retries: 1 });
}

export async function destroySandbox(id) {
  try {
    await request('DELETE', `/v1/sandboxes/${id}`, undefined, { retries: 1 });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

export function listSandboxesByLabel(key, value) {
  return request('GET', `/v1/sandboxes?label=${encodeURIComponent(`${key}=${value}`)}`, undefined, {
    retries: 1,
  });
}

export function extendTtl(id, ttlSeconds) {
  return request('POST', `/v1/sandboxes/${id}/timeout`, { ttl_seconds: ttlSeconds });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Short command, synchronous. Use `runCommand` unless you know it finishes fast. */
export function exec(id, argv, { cwd, env, timeoutMs = 30_000, stdin } = {}) {
  return request(
    'POST',
    `/v1/sandboxes/${id}/exec`,
    { argv, cwd, env, stdin, timeout_ms: Math.min(timeoutMs, 900_000) },
    { timeoutMs: timeoutMs + 15_000, retries: 0 },
  );
}

export function startProcess(id, argv, { cwd, env, pty = false } = {}) {
  return request('POST', `/v1/sandboxes/${id}/processes`, { argv, cwd, env, pty }, { retries: 1 });
}

export function getProcess(id, processId) {
  return request('GET', `/v1/sandboxes/${id}/processes/${processId}`, undefined, { retries: 1 });
}

export function killProcess(id, processId) {
  return request('DELETE', `/v1/sandboxes/${id}/processes/${processId}`, undefined, { retries: 0 }).catch(
    () => null,
  );
}

export function readProcessLogs(id, processId, stdoutOffset = 0, stderrOffset = 0) {
  return request(
    'GET',
    `/v1/sandboxes/${id}/processes/${processId}/logs?stdout_offset=${stdoutOffset}&stderr_offset=${stderrOffset}`,
    undefined,
    { timeoutMs: 60_000, retries: 1 },
  );
}

/**
 * Run a command to completion, choosing the transport by expected duration.
 *
 * `onOutput` receives incremental chunks so the caller can stream them to the browser as
 * they arrive rather than buffering the whole build.
 */
export async function runCommand(id, argv, options = {}) {
  const {
    cwd = WORKSPACE_ROOT,
    env,
    timeoutMs = 120_000,
    onOutput,
    signal,
    pollIntervalMs = 700,
  } = options;

  if (timeoutMs <= MAX_SYNCHRONOUS_EXEC_MS && !onOutput) {
    const r = await exec(id, argv, { cwd, env, timeoutMs });
    return {
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      exitCode: r.exit_code,
      durationMs: r.duration_ms,
      truncated: Boolean(r.stdout_truncated || r.stderr_truncated),
    };
  }

  const proc = await startProcess(id, argv, { cwd, env });
  const deadline = Date.now() + timeoutMs;
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let stdout = '';
  let stderr = '';
  let state = 'running';

  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await killProcess(id, proc.id);
        throw new MosaicError('Command cancelled', { status: 499 });
      }
      const logs = await readProcessLogs(id, proc.id, stdoutOffset, stderrOffset);
      if (logs.stdout) {
        stdout += logs.stdout;
        onOutput?.('stdout', logs.stdout);
      }
      if (logs.stderr) {
        stderr += logs.stderr;
        onOutput?.('stderr', logs.stderr);
      }
      stdoutOffset = logs.next_stdout_offset ?? stdoutOffset;
      stderrOffset = logs.next_stderr_offset ?? stderrOffset;
      state = logs.state;
      if (state !== 'running') break;
      await sleep(pollIntervalMs);
    }

    if (state === 'running') {
      await killProcess(id, proc.id);
      return {
        stdout,
        stderr,
        exitCode: 124,
        timedOut: true,
        durationMs: timeoutMs,
      };
    }

    const status = await getProcess(id, proc.id).catch(() => ({ exit_code: null }));
    return {
      stdout,
      stderr,
      exitCode: status.exit_code ?? 0,
      durationMs: Date.now() - (deadline - timeoutMs),
    };
  } catch (err) {
    await killProcess(id, proc.id);
    throw err;
  }
}

/** Convenience: run as the unprivileged project user with proxy credentials injected. */
export function runAsBuilder(id, command, options = {}) {
  const cwd = options.cwd || WORKSPACE_ROOT;
  return runCommand(id, ['builder-run', '--cwd', cwd, '--', 'bash', '-lc', command], {
    ...options,
    cwd: '/workspace',
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function writeFile(id, path, contentBase64) {
  return request(
    'PUT',
    `/v1/sandboxes/${id}/files/content`,
    { path, content_base64: contentBase64, create_parents: true },
    { timeoutMs: 90_000, retries: 2 },
  );
}

export function writeTextFile(id, path, text) {
  return writeFile(id, path, b64encode(text));
}

export async function readFile(id, path) {
  const r = await request('GET', `/v1/sandboxes/${id}/files/content?path=${encodeURIComponent(path)}`);
  return Buffer.from(r.content_base64, 'base64');
}

export async function readTextFile(id, path) {
  return (await readFile(id, path)).toString('utf8');
}

export function listDirectory(id, path) {
  return request('GET', `/v1/sandboxes/${id}/files?path=${encodeURIComponent(path)}`, undefined, {
    retries: 1,
  });
}

export function makeDirectory(id, path) {
  return request('POST', `/v1/sandboxes/${id}/files/mkdir`, { path, recursive: true });
}

export function moveFile(id, source, destination) {
  return request('POST', `/v1/sandboxes/${id}/files/move`, { source, destination, overwrite: true });
}

export function deleteFile(id, path, recursive = false) {
  return request(
    'DELETE',
    `/v1/sandboxes/${id}/files/content?path=${encodeURIComponent(path)}&recursive=${recursive}`,
    undefined,
    { retries: 1 },
  );
}

/**
 * Write a file larger than the 8 MiB single-write cap.
 *
 * Parts are uploaded under a scratch prefix and concatenated in the guest, then the
 * scratch directory is removed. Verified against the live service by the
 * `chunked-upload` feasibility check.
 */
export async function writeLargeFile(id, path, buffer) {
  const chunkSize = SANDBOX_LIMITS.maxUploadChunkBytes;
  if (buffer.length <= chunkSize) {
    return writeFile(id, path, buffer.toString('base64'));
  }
  const scratch = `/workspace/.upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const parts = Math.ceil(buffer.length / chunkSize);
  for (let i = 0; i < parts; i += 1) {
    const slice = buffer.subarray(i * chunkSize, (i + 1) * chunkSize);
    await writeFile(id, `${scratch}/part.${String(i).padStart(5, '0')}`, slice.toString('base64'));
  }
  const r = await exec(
    id,
    ['bash', '-lc', `mkdir -p "$(dirname "$1")" && cat ${scratch}/part.* > "$1" && rm -rf ${scratch}`, '_', path],
    { timeoutMs: 60_000 },
  );
  if (r.exit_code !== 0) throw new MosaicError(`chunked upload failed: ${r.stderr.slice(0, 300)}`);
  return { path, size: buffer.length };
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

export async function createPreview(id, port, expiresInSeconds = SANDBOX_LIMITS.previewExpirySeconds) {
  try {
    return await request('POST', `/v1/sandboxes/${id}/previews`, {
      port,
      expires_in_seconds: expiresInSeconds,
      require_auth: false,
    });
  } catch (err) {
    // Mosaic may cap TTL below the sandbox lifetime. Fall back to 15 minutes rather than
    // failing the whole preview mint; the host still sees the timer and can share the URL.
    if (
      expiresInSeconds > 900 &&
      err instanceof MosaicError &&
      (err.status === 400 || err.status === 422)
    ) {
      return request('POST', `/v1/sandboxes/${id}/previews`, {
        port,
        expires_in_seconds: 900,
        require_auth: false,
      });
    }
    throw err;
  }
}

export function previewReady(id, previewId) {
  return request('GET', `/v1/sandboxes/${id}/previews/${previewId}/ready`, undefined, { retries: 1 });
}

export function revokePreview(id, previewId) {
  return request('DELETE', `/v1/sandboxes/${id}/previews/${previewId}`, undefined, { retries: 0 }).catch(
    () => null,
  );
}

export async function health() {
  const { endpoint } = config();
  const res = await fetch(`${endpoint}/healthz`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res) return { status: 'unreachable' };
  return res.json().catch(() => ({ status: 'unknown' }));
}
