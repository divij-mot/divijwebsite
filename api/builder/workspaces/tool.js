/**
 * POST /api/builder/workspaces/tool
 *
 * Runs one typed tool call against the caller's sandbox and streams ordered NDJSON events
 * back. One line per event, `seq` monotonic within the call, `result` or `error` last.
 *
 * Streaming rather than a single response because an install or a build takes minutes and
 * the user needs to see it working. NDJSON rather than SSE because the client is a fetch
 * reader, not an EventSource, and NDJSON survives proxies that reformat SSE.
 *
 * Nothing about the call is persisted. Arguments, output, and screenshots exist only for
 * the lifetime of this request.
 */

import { TIMEOUTS_MS } from '../../_lib/limits.js';
import {
  HttpError,
  assertSameOrigin,
  readJsonBody,
  requireSession,
  sendError,
  sendJson,
} from '../../_lib/session.js';
import { TOOLS, createContext } from '../../_lib/tools.js';
import { requireWorkspace } from '../../_lib/workspace.js';

export const config = { runtime: 'nodejs', maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  let session;
  let lease;
  let body;
  try {
    session = await requireSession(req);
    assertSameOrigin(req);
    // fs.sync carries a whole project tree on rehydration, so the cap is generous here.
    body = await readJsonBody(req, 24 * 1024 * 1024);
    lease = await requireWorkspace(body.workspace_id, session);
  } catch (err) {
    // Errors before the stream opens are ordinary JSON, so the client can distinguish
    // "the call never started" from "the call started and failed partway".
    return sendError(res, err);
  }

  const toolName = String(body.tool || '');
  const impl = TOOLS[toolName];
  if (!impl) {
    return sendError(res, new HttpError(400, 'unknown_tool', `No such tool: ${toolName}`));
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Defeats proxy buffering, which would otherwise hold the whole stream until completion
  // and defeat the point of streaming at all.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (event) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  // A tool that hangs must not hold the function open until Vercel kills it, because that
  // gives the client no error at all.
  const turnTimeout = setTimeout(() => controller.abort(), TIMEOUTS_MS.agentTurn);

  const ctx = createContext(lease.sandboxId, controller.signal);

  try {
    for await (const event of impl(ctx, body.args || {})) {
      write(event);
      if (controller.signal.aborted) break;
    }
    if (controller.signal.aborted) {
      write({ kind: 'error', seq: 9_999, tool: toolName, error: 'cancelled' });
    }
  } catch (err) {
    const payload =
      err instanceof HttpError
        ? { code: err.code, error: err.message }
        : err?.name === 'MosaicError'
          ? { code: 'sandbox_provider_error', error: err.message, retryable: Boolean(err.retryable) }
          : { code: 'tool_failed', error: 'The tool failed unexpectedly.' };
    if (!(err instanceof HttpError) && err?.name !== 'MosaicError') {
      console.error(`[builder] tool ${toolName} threw:`, err?.message || err);
    }
    write({ kind: 'error', seq: 9_998, tool: toolName, ...payload });
  } finally {
    clearTimeout(turnTimeout);
    if (!res.writableEnded) res.end();
  }
}
