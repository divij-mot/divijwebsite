/**
 * Workspace leases: the mapping from an opaque workspace id to a Mosaic sandbox.
 *
 * The browser only ever sees the workspace id. It never learns the sandbox id, so it
 * cannot address Mosaic directly even if it wanted to.
 *
 * The mapping is stored twice on purpose. The primary copy is in the store (Redis, or
 * process memory when Redis is absent). The recovery copy is in the Mosaic sandbox's own
 * `metadata` labels, which means a cold Vercel instance with no Redis can still find a
 * live sandbox by asking Mosaic. Without that second copy, losing the store would orphan
 * a running sandbox that keeps billing until its TTL.
 */

import { HttpError } from './session.js';
import { QUOTA_LIMITS, SANDBOX_LIMITS, WORKSPACE_ROOT } from './limits.js';
import * as mosaic from './mosaic.js';
import * as store from './store.js';
import { randomBytes, createHash } from 'node:crypto';

const LEASE_TTL_SECONDS = SANDBOX_LIMITS.ttlSeconds + 600;
const LABEL_WORKSPACE = 'builder_workspace';
const LABEL_SESSION = 'builder_session';

const leaseKey = (workspaceId) => `lease:${workspaceId}`;
const ownerKey = (sessionId) => `owner:${sessionId}`;

export function newWorkspaceId() {
  return `ws_${randomBytes(16).toString('base64url')}`;
}

/** Short, non-reversible tag so a sandbox can be attributed to an invite without storing it. */
const shortHash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);

export async function saveLease(workspaceId, lease) {
  await store.set(leaseKey(workspaceId), JSON.stringify(lease), LEASE_TTL_SECONDS);
  await store.set(ownerKey(lease.sessionId), workspaceId, LEASE_TTL_SECONDS);
}

export async function loadLease(workspaceId) {
  const raw = await store.get(leaseKey(workspaceId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function dropLease(workspaceId, sessionId) {
  await store.del(leaseKey(workspaceId));
  if (sessionId) await store.del(ownerKey(sessionId));
  await store.clearEgressHosts(workspaceId);
  await store.forgetPreview(workspaceId);
}

/**
 * Resolve a workspace id to a live sandbox, or throw.
 *
 * Verifies three things in order: the lease exists, it belongs to the calling session,
 * and the sandbox is actually still there. A sandbox that Mosaic has destroyed produces a
 * specific `sandbox_expired` code, which is the signal the browser uses to rehydrate from
 * OPFS rather than showing a generic failure.
 */
export async function requireWorkspace(workspaceId, session) {
  if (typeof workspaceId !== 'string' || !/^ws_[A-Za-z0-9_-]{10,64}$/.test(workspaceId)) {
    throw new HttpError(400, 'invalid_workspace_id', 'Malformed workspace id.');
  }

  let lease = await loadLease(workspaceId);

  if (!lease) {
    // Store lost it (instance recycled, or no Redis configured). Ask Mosaic.
    lease = await recoverLeaseFromMosaic(workspaceId);
    if (lease) await saveLease(workspaceId, lease);
  }

  if (!lease) {
    throw new HttpError(404, 'sandbox_expired', 'This workspace no longer exists. It will be rebuilt.');
  }
  if (lease.sessionId !== session.sid) {
    throw new HttpError(403, 'not_your_workspace', 'This workspace belongs to another session.');
  }

  const info = await mosaic.getSandbox(lease.sandboxId).catch((err) => {
    if (err.status === 404) return null;
    throw err;
  });
  if (!info || info.state === 'destroyed') {
    await dropLease(workspaceId, session.sid);
    throw new HttpError(404, 'sandbox_expired', 'The sandbox expired. It will be rebuilt from your local copy.');
  }

  return { ...lease, workspaceId, state: info.state };
}

async function recoverLeaseFromMosaic(workspaceId) {
  const result = await mosaic.listSandboxesByLabel(LABEL_WORKSPACE, workspaceId).catch(() => null);
  const list = result?.sandboxes ?? (Array.isArray(result) ? result : []);
  const match = list.find((s) => s.state !== 'destroyed');
  if (!match) return null;
  return {
    sandboxId: match.id,
    sessionId: match.metadata?.[LABEL_SESSION] ?? '',
    createdAt: Date.now(),
    runtime: null,
  };
}

/**
 * Enforce one active sandbox per invite code.
 *
 * Without this a user could hold several 2-hour sandboxes at once by refreshing, which is
 * both a cost problem and the easiest way to exhaust a shared host.
 */
export async function releasePriorWorkspace(session) {
  const priorId = await store.get(ownerKey(session.sid));
  if (!priorId || priorId === '') return;
  const lease = await loadLease(priorId);
  if (lease?.sandboxId) await mosaic.destroySandbox(lease.sandboxId).catch(() => {});
  await dropLease(priorId, session.sid);
}

/**
 * Create a sandbox and bring it to a ready state.
 *
 * `builder-init` is run through the durable process API rather than exec, because it
 * launches Chromium and the allowlisting proxy and can exceed the edge's synchronous
 * limit on a cold guest.
 */
export async function createWorkspace(session, inviteHash) {
  const quota = await store.checkAndConsumeQuota(inviteHash, QUOTA_LIMITS);
  if (!quota.ok) {
    throw new HttpError(429, 'quota_exceeded', quotaMessage(quota), {
      retry_after_seconds: quota.retryAfterSeconds,
    });
  }

  await releasePriorWorkspace(session);

  const workspaceId = newWorkspaceId();
  const sandbox = await mosaic.createSandbox({
    labels: {
      [LABEL_WORKSPACE]: workspaceId,
      [LABEL_SESSION]: session.sid,
      builder_invite: shortHash(inviteHash),
    },
  });

  let runtime;
  try {
    runtime = await initializeGuest(sandbox.id);
  } catch (err) {
    // Never leave a half-initialized guest running and billing.
    await mosaic.destroySandbox(sandbox.id).catch(() => {});
    throw err;
  }

  const lease = {
    sandboxId: sandbox.id,
    sessionId: session.sid,
    createdAt: Date.now(),
    expiresAt: Date.now() + SANDBOX_LIMITS.ttlSeconds * 1000,
    runtime,
  };
  await saveLease(workspaceId, lease);

  return { workspaceId, lease, quota };
}

function quotaMessage(quota) {
  if (quota.reason === 'hourly_limit') {
    return `You have created ${quota.limit} sandboxes this hour, which is the limit. Try again shortly.`;
  }
  return `You have created ${quota.limit} sandboxes today, which is the limit. Try again tomorrow.`;
}

/** Run builder-init and parse the containment report it writes. */
export async function initializeGuest(sandboxId) {
  await mosaic.makeDirectory(sandboxId, WORKSPACE_ROOT).catch(() => {});

  const result = await mosaic.runCommand(sandboxId, ['builder-init'], {
    cwd: '/workspace',
    timeoutMs: 90_000,
  });

  let parsed = {};
  const jsonStart = result.stdout.indexOf('{');
  if (jsonStart >= 0) {
    try {
      parsed = JSON.parse(result.stdout.slice(jsonStart));
    } catch {
      parsed = {};
    }
  }

  const runtime = {
    version: parsed.runtime_version || 'unknown',
    containment: parsed.containment || 'unknown',
    egressProxy: Boolean(parsed.egress_proxy),
    portForwarder: Boolean(parsed.port_forwarder),
    browserHelper: Boolean(parsed.browser_helper),
  };

  // Refuse the sandbox rather than run untrusted code in it. Without the namespace or the
  // proxy, project code would have unrestricted internet access, and `builder-run` would
  // refuse to start it anyway -- failing here gives a clear reason instead of a confusing
  // error on the first command.
  if (runtime.containment !== 'enforced' || !runtime.egressProxy) {
    throw new HttpError(
      503,
      'containment_failed',
      'The sandbox started without network containment, so it is not safe to run code in. Try again.',
      { containment: runtime.containment, egress_proxy: runtime.egressProxy },
    );
  }
  return runtime;
}

/**
 * Push the current egress allowlist into the guest.
 *
 * The proxy watches this file and reloads it, so an approved host takes effect without
 * restarting anything the user has running.
 */
export async function syncEgressPolicy(sandboxId, workspaceId) {
  const extra = await store.listEgressHosts(workspaceId);
  const payload = JSON.stringify({ hosts: extra });
  // The guest merges rather than replaces, so the image's baseline registry list survives.
  const script = `
set -e
python3 - "$@" <<'PY'
import json, sys
policy_path = "/etc/builder/egress-allow.json"
with open(policy_path) as f:
    policy = json.load(f)
extra = json.loads(sys.argv[1]).get("hosts", [])
baseline = policy.get("baseline_allow") or policy.get("allow", [])
policy["baseline_allow"] = baseline
policy["allow"] = sorted(set(baseline) | set(extra))
with open(policy_path, "w") as f:
    json.dump(policy, f)
print(len(policy["allow"]))
PY
`;
  const r = await mosaic.exec(sandboxId, ['bash', '-lc', script, '_', payload], { timeoutMs: 20_000 });
  if (r.exit_code !== 0) {
    throw new HttpError(502, 'egress_sync_failed', `Could not update the allowlist: ${r.stderr.slice(0, 200)}`);
  }
  return { total: Number(r.stdout.trim()) || 0, added: extra };
}

export { LABEL_WORKSPACE, LABEL_SESSION };
