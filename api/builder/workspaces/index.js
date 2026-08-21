/**
 * POST   /api/builder/workspaces  -- create a sandbox and return an opaque workspace id
 * GET    /api/builder/workspaces?workspace_id=...  -- lease status and time remaining
 * DELETE /api/builder/workspaces  -- revoke previews, kill processes, destroy the sandbox
 *
 * The response never contains the Mosaic sandbox id. The browser addresses the sandbox
 * only through the workspace id, so a compromised client cannot talk to Mosaic directly.
 */

import { SANDBOX_LIMITS } from '../../_lib/limits.js';
import * as mosaic from '../../_lib/mosaic.js';
import {
  HttpError,
  assertSameOrigin,
  readJsonBody,
  requireSession,
  sendError,
  sendJson,
} from '../../_lib/session.js';
import * as store from '../../_lib/store.js';
import {
  createWorkspace,
  dropLease,
  loadLease,
  requireWorkspace,
} from '../../_lib/workspace.js';

export const config = { runtime: 'nodejs', maxDuration: 120 };

export default async function handler(req, res) {
  try {
    const session = await requireSession(req);

    if (req.method === 'GET') {
      const workspaceId = new URL(req.url, 'http://localhost').searchParams.get('workspace_id');
      if (!workspaceId) throw new HttpError(400, 'missing_workspace_id', 'workspace_id is required.');
      const lease = await requireWorkspace(workspaceId, session);
      return sendJson(res, 200, {
        workspace_id: workspaceId,
        state: lease.state,
        expires_at: lease.expiresAt ?? null,
        seconds_remaining: lease.expiresAt ? Math.max(0, Math.round((lease.expiresAt - Date.now()) / 1000)) : null,
        runtime: lease.runtime,
      });
    }

    assertSameOrigin(req);

    if (req.method === 'POST') {
      const health = await mosaic.health();
      if (health.runtime && health.runtime !== 'operational') {
        // Mosaic's runtime degrades independently of its edge, and during those windows
        // creates return Cloudflare HTML rather than a usable error. Fail clearly here
        // instead of surfacing a parse error from deep inside the client.
        throw new HttpError(
          503,
          'sandbox_provider_degraded',
          'The sandbox provider is having problems right now. Your project is safe locally; try again shortly.',
          { provider_status: health.status },
        );
      }

      const { workspaceId, lease } = await createWorkspace(session, session.h);
      return sendJson(res, 201, {
        workspace_id: workspaceId,
        expires_at: lease.expiresAt,
        ttl_seconds: SANDBOX_LIMITS.ttlSeconds,
        workspace_root: '/workspace/project',
        runtime: lease.runtime,
      });
    }

    if (req.method === 'DELETE') {
      const body = await readJsonBody(req, 4096);
      const workspaceId = body.workspace_id;
      if (!workspaceId) throw new HttpError(400, 'missing_workspace_id', 'workspace_id is required.');

      const lease = await loadLease(workspaceId);
      if (!lease) return sendJson(res, 200, { ok: true, already_gone: true });
      if (lease.sessionId !== session.sid) {
        throw new HttpError(403, 'not_your_workspace', 'This workspace belongs to another session.');
      }

      // Revoke the preview before destroying the sandbox so the public URL stops serving
      // immediately rather than at whatever moment the guest happens to die.
      const preview = await store.recallPreview(workspaceId);
      if (preview?.previewId) {
        await mosaic.revokePreview(lease.sandboxId, preview.previewId).catch(() => {});
      }
      await mosaic.destroySandbox(lease.sandboxId).catch(() => {});
      await dropLease(workspaceId, session.sid);

      return sendJson(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    return sendError(res, err);
  }
}
