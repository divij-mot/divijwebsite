/**
 * POST /api/builder/egress/allow -- add a user-approved hostname to this sandbox's proxy
 * GET  /api/builder/egress/allow -- list what has been approved for this workspace
 *
 * The guest cannot reach the internet except through its allowlisting proxy, and the
 * baseline allowlist covers package registries only. Anything the generated app talks to
 * -- an API the user asked for, a CDN a library needs -- goes through here, and only after
 * the user explicitly approves it in the UI. The agent can request a host but cannot
 * approve one.
 *
 * Two independent checks apply. This endpoint refuses IP literals and internal names; the
 * in-guest proxy separately resolves the name at connection time and refuses any answer
 * in a private, loopback, link-local, or metadata range, which is what defeats a DNS
 * rebind that resolves publicly here and privately later.
 */

import {
  HttpError,
  assertSameOrigin,
  readJsonBody,
  requireSession,
  sendError,
  sendJson,
} from '../../_lib/session.js';
import * as store from '../../_lib/store.js';
import { assertPublicHostname } from '../../_lib/validate.js';
import { requireWorkspace, syncEgressPolicy } from '../../_lib/workspace.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

/** A long allowlist stops being a meaningful restriction. */
const MAX_HOSTS_PER_WORKSPACE = 25;

export default async function handler(req, res) {
  try {
    const session = await requireSession(req);

    if (req.method === 'GET') {
      const workspaceId = new URL(req.url, 'http://localhost').searchParams.get('workspace_id');
      await requireWorkspace(workspaceId, session);
      return sendJson(res, 200, { hosts: await store.listEgressHosts(workspaceId) });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    assertSameOrigin(req);
    const body = await readJsonBody(req, 8192);
    const lease = await requireWorkspace(body.workspace_id, session);

    // The UI shows a confirmation dialog naming the host; this flag is how it reports that
    // the user said yes. Without it the request is refused, so the agent cannot self-approve.
    if (body.approved !== true) {
      throw new HttpError(
        403,
        'approval_required',
        'Adding a network destination requires explicit user approval.',
      );
    }

    const hostname = assertPublicHostname(body.hostname);
    const current = await store.listEgressHosts(body.workspace_id);
    if (current.includes(hostname)) {
      return sendJson(res, 200, { ok: true, hostname, already_allowed: true, hosts: current });
    }
    if (current.length >= MAX_HOSTS_PER_WORKSPACE) {
      throw new HttpError(
        429,
        'too_many_hosts',
        `This workspace already allows ${MAX_HOSTS_PER_WORKSPACE} hosts, which is the limit.`,
      );
    }

    await store.addEgressHost(body.workspace_id, hostname);
    const synced = await syncEgressPolicy(lease.sandboxId, body.workspace_id);

    return sendJson(res, 200, {
      ok: true,
      hostname,
      hosts: await store.listEgressHosts(body.workspace_id),
      total_allowed: synced.total,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
