/**
 * Typed client for /api/builder/*.
 *
 * Usable from both the UI thread and the Agent Worker. All requests are same-origin and
 * carry the HttpOnly session cookie automatically, so nothing here handles credentials.
 */

import type { PreviewInfo, ToolStreamEvent, WorkspaceLease } from '../core/types';

export class ControlPlaneError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }

  /** The sandbox is gone and the caller should rebuild it from the local tree. */
  get isSandboxGone(): boolean {
    return this.code === 'sandbox_expired' || this.code === 'not_your_workspace';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body from our own API means an edge or platform error page rather than
      // an application response; say so instead of throwing a parse error at the user.
      throw new ControlPlaneError(
        `The server returned an unexpected response (${res.status}).`,
        'bad_response',
        res.status,
        res.status >= 500,
      );
    }
  }

  if (!res.ok) {
    // A 404 from our own API means the serverless functions are not being served, which
    // happens when the app is run with `vite` instead of `vercel dev`. Saying "not found"
    // would send someone hunting for a bug in their invite code.
    const message =
      res.status === 404 && !body.error
        ? 'The builder API is not responding. If you are running locally, use `vercel dev` rather than `vite` so /api routes are served.'
        : String(body.message || body.error || `Request failed with ${res.status}`);

    throw new ControlPlaneError(
      message,
      String(body.error || (res.status === 404 ? 'api_unavailable' : 'unknown')),
      res.status,
      Boolean(body.retryable) || res.status >= 500 || res.status === 429,
    );
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthStatus {
  authenticated: boolean;
  durable_store: boolean;
  turnstile_site_key: string | null;
}

export const getAuthStatus = () => request<AuthStatus>('/api/builder/auth');

export const signIn = (code: string, turnstileToken?: string) =>
  request<{ ok: true }>('/api/builder/auth', {
    method: 'POST',
    body: JSON.stringify({ code, turnstile_token: turnstileToken }),
  });

export const signOut = () => request<{ ok: true }>('/api/builder/auth', { method: 'DELETE' });

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

interface CreateWorkspaceResponse {
  workspace_id: string;
  expires_at: number;
  runtime: WorkspaceLease['runtime'];
}

export async function createWorkspace(): Promise<WorkspaceLease> {
  const r = await request<CreateWorkspaceResponse>('/api/builder/workspaces', { method: 'POST' });
  return { workspaceId: r.workspace_id, expiresAt: r.expires_at, runtime: r.runtime };
}

export const getWorkspace = (workspaceId: string) =>
  request<{ state: string; seconds_remaining: number | null; runtime: WorkspaceLease['runtime'] }>(
    `/api/builder/workspaces?workspace_id=${encodeURIComponent(workspaceId)}`,
  );

export const destroyWorkspace = (workspaceId: string) =>
  request<{ ok: true }>('/api/builder/workspaces', {
    method: 'DELETE',
    body: JSON.stringify({ workspace_id: workspaceId }),
  });

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export async function startPreview(workspaceId: string, force = false): Promise<PreviewInfo & { ready: boolean }> {
  const r = await request<{
    url: string;
    expires_at: number;
    port: number;
    ready?: boolean;
    embeddable?: boolean;
  }>('/api/builder/workspaces/preview', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: workspaceId, force }),
  });
  return {
    url: r.url,
    expiresAt: r.expires_at,
    port: r.port,
    ready: r.ready !== false,
    ...(typeof r.embeddable === 'boolean' ? { embeddable: r.embeddable } : {}),
  };
}

export const stopPreview = (workspaceId: string) =>
  request<{ ok: true }>('/api/builder/workspaces/preview', {
    method: 'DELETE',
    body: JSON.stringify({ workspace_id: workspaceId }),
  });

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------

export const allowEgressHost = (workspaceId: string, hostname: string) =>
  request<{ ok: true; hosts: string[] }>('/api/builder/egress/allow', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: workspaceId, hostname, approved: true }),
  });

export const listEgressHosts = (workspaceId: string) =>
  request<{ hosts: string[] }>(
    `/api/builder/egress/allow?workspace_id=${encodeURIComponent(workspaceId)}`,
  );

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolCallOptions {
  workspaceId: string;
  tool: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  onEvent?: (event: ToolStreamEvent) => void;
}

/**
 * Run a tool and consume its NDJSON stream.
 *
 * Returns the payload of the final `result` event. Intermediate events go to `onEvent` so
 * a build's output can render while it runs rather than appearing all at once at the end.
 */
export async function callTool<T = unknown>(options: ToolCallOptions): Promise<T> {
  const res = await fetch('/api/builder/workspaces/tool', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      workspace_id: options.workspaceId,
      tool: options.tool,
      args: options.args,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      throw new ControlPlaneError(`Tool call failed (${res.status}).`, 'bad_response', res.status, res.status >= 500);
    }
    throw new ControlPlaneError(
      String(body.message || body.error || 'Tool call failed'),
      String(body.error || 'tool_failed'),
      res.status,
      Boolean(body.retryable),
    );
  }

  if (!res.body) throw new ControlPlaneError('The tool stream was empty.', 'empty_stream', 502, true);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: T | undefined;
  let failure: ControlPlaneError | null = null;

  const consume = (line: string) => {
    if (!line.trim()) return;
    let event: ToolStreamEvent;
    try {
      event = JSON.parse(line) as ToolStreamEvent;
    } catch {
      return; // a truncated final line is not worth failing the whole call over
    }
    options.onEvent?.(event);
    if (event.kind === 'result') result = event.data as T;
    if (event.kind === 'error') {
      failure = new ControlPlaneError(
        event.error || 'The tool failed.',
        (event as { code?: string }).code || 'tool_failed',
        500,
        false,
      );
    }
    if (event.kind === 'confirm-required') {
      result = { __confirmationRequired: true, ...(event.data as object) } as T;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      consume(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  consume(buffer);

  if (failure) throw failure;
  if (result === undefined) {
    throw new ControlPlaneError('The tool produced no result.', 'no_result', 502, true);
  }
  return result;
}
