# Mosaic Sandbox — bug reports and suggestions

Found while building a browser-based app builder on Mosaic Sandbox in August 2026.
The product runs untrusted AI-generated Node projects in disposable sandboxes, with a
dev server, a public preview, and Playwright tests inside the guest.

Endpoint: `https://sandbox.mosaicos.com` · CLI `mos` 0.9.0 · region `silicon-valley`

Each item is three sentences: what happens, why it matters, what would fix it.
Ordered by how much it hurt.

---

## Bugs

### 1. Snapshots break permanently when you delete the sandbox they came from

If you snapshot a sandbox and then delete that sandbox, every later restore from that
snapshot fails, even though `GET /v1/snapshots/{id}` still reports `"state": "ready"`.
This makes snapshots useless for their main purpose — saving a prepared machine and
throwing away the original — and you only discover it at restore time, which could be
days later. The snapshot should copy or reflink its disk into storage it owns instead of
pointing at `/var/lib/mar/runtime/mar-<origin-id>/`, and until then a snapshot whose
origin is gone should report a broken state rather than `ready`.

Reproduction (about 15 seconds):

```bash
ID=$(mos create --template node-22 | jq -r .id)
mos exec "$ID" -- sh -c 'echo hello > /workspace/marker.txt'
mos snapshot create "$ID" --name repro-test
mos create --snapshot repro-test          # works
mos destroy "$ID"
mos create --snapshot repro-test          # fails
```

The failure:

```
400 invalid_request: Firecracker API error: Load snapshot error: Failed to restore from
snapshot: Failed to build microVM from snapshot: Failed to restore devices: Error
restoring MMIO devices: Block: Virtio backend error: Error manipulating the backing file:
No such file or directory (os error 2) /var/lib/mar/runtime/mar-<origin-sandbox-id>/...
```

Container-image environments (`POST /v1/environments`) do not have this problem — they
come back with `source_sandbox_id: ""` and keep working after their children are
destroyed. We switched our whole runtime to environments because of this.

### 2. Durable processes start with an empty environment, but `exec` does not

A command run through `POST /v1/sandboxes/{id}/exec` gets the container image's `ENV`,
but the same command run through `POST /v1/sandboxes/{id}/processes` gets none of it.
This is invisible until something fails oddly much later — for us a dev server started
fine but could not find its browser binary, because `PLAYWRIGHT_BROWSERS_PATH` was set in
the image and silently absent in the process. The two endpoints should build the
environment the same way, and whichever behaviour you keep should be stated in the docs
next to both.

Reproduction:

```bash
# Build any environment from an image with an ENV line, then:
mos exec "$ID" -- sh -lc 'echo "exec sees: $MY_IMAGE_VAR"'      # prints the value
mos process start "$ID" -- sh -lc 'echo "process sees: $MY_IMAGE_VAR"'  # prints empty
```

### 3. Long `exec` calls fail with a Cloudflare error page instead of a timeout

An `exec` that runs for roughly 45 seconds or more comes back as HTTP 520 or 502 with a
Cloudflare HTML page, even when `timeout_ms` was set to 300000. Any client that expects
JSON crashes on the HTML, and the caller cannot tell a slow command apart from a real
outage. Either hold the connection for the full `timeout_ms`, or reject a `timeout_ms`
above the real edge limit at request time so the caller knows to use a durable process
instead.

### 4. Errors during a degraded runtime are HTML, not JSON

While `GET /healthz` reported `"runtime": "degraded"`, `POST /v1/sandboxes` returned a
Cloudflare HTML error page rather than the documented `{"error": ..., "request_id": ...}`
shape. Every SDK and script that calls `response.json()` throws a parse error, which hides
the real cause and sends people debugging their own code. Returning the JSON error shape
for all 5xx responses, including edge-level ones, would make outages self-explanatory.

---

### 5. The guest kernel has no firewall, so per-user network rules are impossible

The Firecracker kernel (6.1.177) has no nf_tables support — `nft add table inet t` returns
"Operation not supported" — and although legacy xtables works, its `xt_owner` module is
missing, so `-m owner --uid-owner` fails with "Extension owner revision 0 not supported".
Anyone trying to confine untrusted code to a proxy hits this after their firewall rules
appear to apply and then silently do nothing, which is the worst possible failure mode for
a security control. Compiling `CONFIG_NF_TABLES` and `CONFIG_NETFILTER_XT_MATCH_OWNER`
into the guest kernel would fix it, and in the meantime the docs should say plainly that
in-guest firewalling is unavailable.

Worth knowing: network namespaces do work, and `unshare -n`, `ip netns`, and veth pairs
are all functional. We ended up running project code in a namespace with no default route,
which is a stronger guarantee than a firewall rule anyway. But it took a while to discover
that this was the only option.

---

## Documentation gaps

### 6. Required query parameters are missing from the OpenAPI spec

`GET /v1/sandboxes/{id}/files` needs a `path` parameter and
`GET /v1/sandboxes/{id}/processes/{process_id}/logs` needs `stdout_offset` and
`stderr_offset`, but none of them appear in `openapi.json`. Anyone generating a client
from the spec gets methods that cannot actually be called, and has to read the prose docs
or guess. Adding the parameters to the spec would fix generated clients for free.

### 7. Nothing says commands run as root

Every guest command runs as `root`, which is reasonable for a microVM but worth saying
out loud, because people running untrusted or model-generated code usually want to drop
privileges. We ended up creating our own unprivileged user in the image and wrapping every
command with `runuser`. A short note in the docs, or an optional `user` field on `exec` and
`processes`, would save that work.

### 8. `WORKINGDIR` is dropped but `ENV` is kept, which is easy to miss

The docs mention this once, and it is genuinely surprising that half of the image's
configuration survives and half does not. Combined with item 2 it means an image's
environment behaves three different ways depending on how you invoke it. A short table of
what is preserved — `ENV` yes, `WORKINGDIR` no, `USER` no, `ENTRYPOINT` no — would settle it.

---

### 10. Preview URLs cannot be embedded in an iframe

`GET` on a working preview URL returns the guest HTML (a Next.js app, in our case) but
attaches the Mosaic control-plane security headers: `X-Frame-Options: DENY` and CSP
`frame-ancestors 'none'`, including `connect-src` entries for Google accounts and GitHub
that the guest never set. The URL renders correctly in a top-level tab and is blank in a
cross-origin iframe, which is the embedding the docs imply preview URLs are for. Preview
responses should forward the guest's own headers, or at least drop `X-Frame-Options` and
set `frame-ancestors *` (or a caller-supplied origin) on `sandbox.mosaicos.com/preview/*`.

Reproduction: create a preview, `curl -sSD - -o /tmp/p.html "$URL"`, observe the guest
body and the control-plane CSP on the same response, then load the URL in an iframe.

---

### 9. Preview URLs return 502 rather than a clear "revoked" response

After `DELETE /v1/sandboxes/{id}/previews/{preview_id}`, the URL starts returning a bare
502. Revocation genuinely works, which is the important part, but a monitoring system
cannot tell a deliberately revoked preview apart from a crashed dev server or a platform
outage. A 410 Gone, or any small JSON body saying the preview was revoked, would make that
distinction free.

---

## Things that worked well

- **Container-image environments are excellent.** A 2 GB private image built into an
  environment in 35 seconds and then booted consistently in 200–460 ms. That is fast
  enough to create a fresh sandbox per user session without anyone noticing.
- **Private registry pulls are handled well.** Passing `registry_username` and
  `registry_password` to `POST /v1/environments` worked first try against a private GHCR
  package, and not storing the credential is the right call. Worth making more prominent
  in the docs, since it is the difference between publishing your runtime publicly or not.
- **The durable process API with byte-offset log cursors is the right design.** Being able
  to reconnect to a running build and resume reading from an offset is exactly what a web
  UI needs, and it survived hibernation and reconnects in our testing.
- **Idle hibernation is genuinely transparent.** A sandbox left alone for 20 seconds came
  back on the next file read with its workspace intact and no special handling.
- **Preview URLs behave correctly, including revocation.** A revoked preview stopped
  serving immediately. Framing is a separate bug (item 10); revocation itself is fine.

---

## Feature requests

### A way to run a command as a non-root user

Either a `user` field on `exec` and `processes`, or an image `USER` that is honoured.
Right now anyone running untrusted code has to build a custom image just to get an
unprivileged account, which is a lot of work for something most sandbox users want. It
would also make the stock `node-22` and `python-3.11` templates safe for that use case out
of the box.

### Kernel support for confining a process to a proxy

Related to item 5, and the single change that would have saved us the most time. With
`CONFIG_NF_TABLES` and `CONFIG_NETFILTER_XT_MATCH_OWNER` compiled in, "this user may only
reach the internet through this proxy" is four lines of configuration. Without them it is
a network namespace, a veth pair, a port forwarder to keep previews working, and a
service placement diagram — all of which we ended up building and which every other
customer with the same requirement will build again.

---

## Summary for triage

| # | Severity | One line |
| --- | --- | --- |
| 1 | High | Snapshots break permanently once their origin sandbox is deleted, while still reporting `ready`. |
| 2 | High | Durable processes do not inherit the image `ENV`; `exec` does. |
| 5 | High | Guest kernel has no nf_tables and no `xt_owner`, so in-guest firewalling is impossible. |
| 3 | Medium | Long `exec` calls return Cloudflare HTML instead of honouring `timeout_ms`. |
| 4 | Medium | 5xx responses during a degraded runtime are HTML, not the documented JSON error shape. |
| 10 | High | Preview URLs send `X-Frame-Options: DENY`, so they cannot be iframed. |
| 9 | Low | Revoked previews return a bare 502 rather than something distinguishable. |
| 6 | Low | `openapi.json` omits required query parameters on two endpoints. |
| 7 | Low | Not documented that commands run as root. |
| 8 | Low | Not obvious that `ENV` is preserved but `WORKINGDIR` is not. |

Items 1, 2, and 5 each cost roughly half a day, and all three had the same shape: the
documented or apparent behaviour differed from the actual behaviour, and the difference
only surfaced under load or at a security boundary rather than at the call that caused it.
Happy to provide reproductions for any of them.
