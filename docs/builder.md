# Portable Mosaic Builder

A local-first app builder at `/builder`. It behaves like Bolt or Lovable, except that your
source, chat, and history live in your browser rather than on a server, and the export is
a plain ZIP that Vercel Drop can deploy.

```
Browser (the durable copy)
├── Builder UI: chat, editor, preview, logs
├── OPFS blobs + IndexedDB manifests, chat, checkpoints
└── Agent Web Worker (holds the API key, in memory only)
    ├── Approved providers → stateless Vercel relay
    ├── Custom endpoint    → direct browser request
    └── Tool calls → Vercel control plane → Mosaic sandbox
                                            ├── Node 22, dev server
                                            ├── Chromium / Playwright
                                            └── Allowlisting egress proxy
```

## The one idea everything follows from

**The browser holds the truth; the sandbox is a disposable working copy.**

Every other decision is downstream of that. Sandboxes expire after two hours and are
recreated by replaying the local tree, so an expiry is a pause rather than a loss. The
server stores no project data, so there is nothing to leak. Export is assembled in the
tab, so the chat never passes through an export service.

## What is stored where

| Where | What | Notes |
| --- | --- | --- |
| OPFS | File bytes, content-addressed by SHA-256 | Deduplicated, so a checkpoint before every turn costs only what changed |
| IndexedDB | Manifests, checkpoints, chat, provider preferences | Never the API key |
| Worker memory | The provider API key | Gone on reload, by design |
| Redis (optional) | Invite hashes, quotas, preview ids, egress allowlists | Never prompts, source, or responses |
| Mosaic labels | Workspace → sandbox lease | So a cold instance can find a live sandbox without a database |
| Mosaic guest | A working copy of the source | Destroyed with the sandbox |

Nothing in the second half of that table can reconstruct a project.

## Setup

1. **Build and publish the runtime image**, then convert it to a Mosaic environment. See
   [`runtime/README.md`](../runtime/README.md).

2. **Set the environment variables** from [`.env.example`](../.env.example). The required
   ones are `MOSAIC_API_KEY`, `BUILDER_SESSION_SECRET`, and `BUILDER_INVITE_CODES`.
   Upstash Redis and Turnstile are optional; without Redis, quotas and invite revocation
   fall back to per-instance memory, which is fine for a solo beta.

3. **Verify the gate** before trusting anything:

   ```bash
   node scripts/mosaic-feasibility.mjs              # provider behaviour and limits
   node scripts/mosaic-build-environment.mjs --verify-only
   node scripts/e2e-sandbox.mjs                     # full live acceptance run
   ```

4. **Run it.** `/api/builder/*` needs the Vercel runtime, so use `vercel dev` rather than
   `vite` when working on the control plane.

## Using it

Enter an invite code, add a provider key in Settings (it is tested for authentication,
streaming, function calling, and vision before Agent mode unlocks), then describe what you
want. The agent inspects the project, edits it, runs the dev server, drives a real Chromium
against the result, and only reports success once the build passes and the flow you asked
for actually works.

**Download ZIP** produces a deployable archive: source at the root, `vercel.json`,
`.vercelignore`, `.env.example`, `DEPLOYMENT.md`, and `.builder/` holding your chat so a
re-import restores the session. Drag it onto [vercel.com/drop](https://vercel.com/drop).
Drop creates a new project per drop; use Git or the CLI to keep updating one URL.

No credentials are ever in the archive. Neither is hosted database content — a
database-backed export builds without `DATABASE_URL`, runs in a labelled demo mode, and
becomes persistent once you connect Postgres in Vercel and redeploy.

## Security boundaries

These are the four places something could go wrong, and what stops it.

**Untrusted archives.** Every ZIP entry is judged before a byte is extracted: traversal,
absolute paths, symlinks, device files, per-entry size, compression ratio, file count, and
case-collisions. The browser checks first for fast feedback; the control plane repeats
every check before anything reaches Mosaic, because a validated-in-the-browser guarantee
is worth nothing server-side.

**Untrusted generated code.** It runs as uid 1001 inside a network namespace with no
default route. The only reachable destination is an allowlisting proxy that resolves DNS
itself and refuses any answer in a private, loopback, link-local, or metadata range.
Adding a host requires the user to approve it; the agent can ask but cannot self-approve.

**Untrusted model output in the UI.** Markdown is parsed into React elements, never
injected as HTML, and links are restricted to http(s). The `/builder` route ships a CSP
that permits no third-party scripts.

**The preview iframe.** Sandboxed with `allow-scripts allow-forms allow-modals
allow-popups allow-downloads`, and deliberately **without** `allow-top-navigation` (a
generated page could otherwise redirect the whole builder tab) or `allow-same-origin`
(which, with scripts, would let the frame reach this origin's storage and read the
project).

## Testing

```bash
npm test           # 187 unit tests
npm run typecheck  # tsc over src/builder
node scripts/e2e-sandbox.mjs   # 22 live checks against a real sandbox
```

The unit tests cover archive hardening, path containment (the same rejection corpus runs
against both the browser and server validators), checkpoint deduplication and restore,
ZIP round-trips, secret exclusion, provider streaming against deliberately hostile chunk
boundaries, and the scaffold's build-without-credentials contract.

`scripts/e2e-sandbox.mjs` calls the real `api/_lib/tools.js` implementations rather than
reimplementing them, so a bug in shipped code fails the run. It covers acceptance
scenarios 1, 3, and 7 from the plan.

`scripts/mosaic-feasibility.mjs` includes a regression guard that **passes while a known
Mosaic defect is still present** and fails if it is fixed, so the workaround gets removed
deliberately rather than forgotten. See [`docs/mosaic-feedback.md`](./mosaic-feedback.md).

## Known limits

- Desktop-first and Chromium-first. Mobile gives chat, code viewing, preview, and logs, but
  not editing.
- JavaScript and TypeScript only. New projects are Next.js App Router; imports may be any
  Vercel-supported JS framework.
- No interactive terminal in v1. The agent's command output is shown; a shell is not.
- The API key must be re-entered after a reload. That is the cost of never persisting it.
- Sandbox snapshots are not used at all, because Mosaic's are not durable. Warm starts come
  from the container-image environment instead.
