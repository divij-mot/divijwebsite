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

   **Redis is optional but quotas do nothing without it.** The store falls back to
   per-instance memory, and since every serverless invocation gets a fresh instance, the
   hourly and daily limits count from zero every time. The invite gate and the
   one-sandbox-per-session rule still work. Provision it with:

   ```bash
   vercel integration add upstash/upstash-kv
   ```

   That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` on the project, which the store
   accepts as aliases for the `UPSTASH_` names. One local-development wrinkle: the
   integration writes them to `.env.local`, but `vercel dev` reads `.env`, so copy those
   two values across or local runs will silently use the memory driver. Confirm with:

   ```bash
   node scripts/check-store.mjs
   ```

   Turnstile is also optional and skipped entirely when no secret key is set.

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
allow-popups allow-downloads` and `allow-same-origin`. Mosaic preview URLs currently
send `X-Frame-Options: DENY`, so the pane does not load them directly. The control plane
reverse-proxies the guest through a **sibling origin** (`localhost` ↔ `127.0.0.1`
locally, custom domain ↔ the deployment's `*.vercel.app` in production) and strips those
headers. Guest HTML is rewritten so `/_next` assets stay under `/__p/<preview-token>/`,
because Chrome treats the two hosts as different sites and will not send a cookie from
the iframe. Same-origin on the iframe is then safe because the frame's origin is never
the builder's; without it a Next.js app gets an opaque origin and hydrates to a blank
page. Top navigation is withheld so a generated page cannot redirect the builder tab.

The rest of the site uses a COI service worker so FFmpeg can use `SharedArrayBuffer`.
That isolation is skipped on `/builder`, because it would block the preview iframe.

### Why the headers in `vercel.json` are what they are

Vercel's config schema rejects unknown properties, so the reasoning lives here rather than
as comments in the file.

The `/builder` route gets a stricter policy than the rest of the site because it is the
only page that renders untrusted model output and embeds a sandbox preview:

- `connect-src` lists `'self'` (the model relay) plus the provider origins the Agent Worker
  calls directly with a user's own key (currently DeepSeek). A custom endpoint therefore
  needs adding here as well as in Settings — a deliberate friction, since it is the one
  case where a key leaves for a host we do not control.
- `frame-src` allows the sibling origins the preview proxy uses (`127.0.0.1` / `localhost`,
  `*.vercel.app`, and this site's domains) plus Mosaic, so a generated page cannot embed
  an arbitrary third party.
- `frame-ancestors 'none'` and `X-Frame-Options: DENY` keep the builder itself out of
  someone else's frame, which would otherwise enable clickjacking against a session.
- `wasm-unsafe-eval` is present because the site's FFmpeg tooling needs WebAssembly; plain
  `unsafe-eval` is not.
- No third-party scripts load on this route at all.

`/api/builder/*` responses are per-session and `no-store`, so a shared proxy can never
serve one user's workspace state to another.

## Testing

```bash
npm test                       # unit tests
npm run typecheck              # tsc over src/builder
node scripts/check-store.mjs   # 14 checks: is Redis wired up, do quotas enforce
node scripts/e2e-sandbox.mjs   # 22 live checks against a real sandbox
node scripts/e2e-api.mjs       # 32 checks over the HTTP control plane (needs `vercel dev`)
```

The unit tests cover archive hardening, path containment (the same rejection corpus runs
against both the browser and server validators), checkpoint deduplication and restore,
ZIP round-trips, secret exclusion, provider streaming against deliberately hostile chunk
boundaries, and the scaffold's build-without-credentials contract.

`scripts/e2e-sandbox.mjs` calls the real `api/_lib/tools.js` implementations rather than
reimplementing them, so a bug in shipped code fails the run. It covers acceptance
scenarios 1, 3, and 7 from the plan.

`scripts/e2e-api.mjs` covers everything above the library layer — routing, the session
cookie's flags, origin enforcement, server-side path validation, NDJSON framing, egress
approval, and relay SSRF refusal. It exists because both bugs found after the initial
implementation lived exactly there and nothing else would have caught them. Two of its
assertions are regression guards: one for a `DELETE` that leaked a live sandbox, one for a
recovered lease that lost its expiry.

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
