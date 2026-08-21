/**
 * POST   /api/builder/workspaces/preview -- start or reuse a preview for the dev server
 * DELETE /api/builder/workspaces/preview -- revoke it immediately
 *
 * A preview is a public capability URL: anyone holding it can reach the app. That is
 * acceptable for a 15-minute window on a disposable sandbox, and it is why the URL is
 * revoked on destroy rather than left to expire.
 *
 * Playwright verification does not use this. Tests hit http://127.0.0.1:3000 inside the
 * guest, so an app under test is never exposed publicly just to be checked.
 */

import { SANDBOX_LIMITS } from '../../_lib/limits.js';
import * as mosaic from '../../_lib/mosaic.js';
import { previewEmbeddable } from '../../_lib/previewEmbed.js';
import {
  HttpError,
  assertSameOrigin,
  readJsonBody,
  requireSession,
  sendError,
  sendJson,
} from '../../_lib/session.js';
import * as store from '../../_lib/store.js';
import { requireWorkspace } from '../../_lib/workspace.js';

export const config = { runtime: 'nodejs', maxDuration: 120 };

/** Rotate slightly before expiry so the iframe never shows an expired-preview page. */
const RENEW_MARGIN_MS = 90_000;

export default async function handler(req, res) {
  try {
    const session = await requireSession(req);
    assertSameOrigin(req);

    const body = await readJsonBody(req, 4096);
    const lease = await requireWorkspace(body.workspace_id, session);

    if (req.method === 'DELETE') {
      const existing = await store.recallPreview(body.workspace_id);
      if (existing?.previewId) {
        await mosaic.revokePreview(lease.sandboxId, existing.previewId);
        await store.forgetPreview(body.workspace_id);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, DELETE');
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    const port = Number(body.port) || SANDBOX_LIMITS.devPort;
    if (port !== SANDBOX_LIMITS.devPort) {
      // Only the dev port is exposed. Allowing arbitrary ports would let the agent publish
      // the in-guest browser helper or the egress proxy.
      throw new HttpError(400, 'port_not_allowed', `Only port ${SANDBOX_LIMITS.devPort} can be previewed.`);
    }

    const existing = await store.recallPreview(body.workspace_id);
    if (existing && existing.expiresAt - Date.now() > RENEW_MARGIN_MS && !body.force) {
      const ready = await mosaic.previewReady(lease.sandboxId, existing.previewId).catch(() => ({ ready: false }));
      if (ready.ready && existing.url) {
        const embeddable = await previewEmbeddable(existing.url);
        return sendJson(res, 200, {
          url: existing.url,
          expires_at: existing.expiresAt,
          port,
          reused: true,
          embeddable,
        });
      }
    }

    if (existing?.previewId) {
      await mosaic.revokePreview(lease.sandboxId, existing.previewId).catch(() => {});
    }

    const preview = await mosaic.createPreview(lease.sandboxId, port, SANDBOX_LIMITS.previewExpirySeconds);
    const expiresAt = Math.round(Number(preview.expires_at_ns) / 1e6);

    let ready = false;
    for (let i = 0; i < 25; i += 1) {
      const r = await mosaic.previewReady(lease.sandboxId, preview.id).catch(() => ({ ready: false }));
      if (r.ready) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    await store.rememberPreview(body.workspace_id, preview.id, expiresAt);
    // The URL is stored alongside the id so a reuse check does not need another Mosaic call.
    await store.set(
      `preview:${body.workspace_id}`,
      JSON.stringify({ previewId: preview.id, expiresAt, url: preview.url }),
      24 * 60 * 60,
    );

    const embeddable = await previewEmbeddable(preview.url);
    return sendJson(res, 200, {
      url: preview.url,
      expires_at: expiresAt,
      port,
      ready,
      reused: false,
      embeddable,
      ...(ready
        ? {}
        : { warning: 'The preview URL exists but the dev server has not answered yet. It may still be starting.' }),
    });
  } catch (err) {
    return sendError(res, err);
  }
}
