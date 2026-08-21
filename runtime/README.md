# Builder runtime image

The sandbox image the builder runs untrusted, model-generated projects inside. Node 22,
pnpm, Chromium/Playwright, an unprivileged project user, an allowlisting egress proxy, and
a browser automation service.

Published privately to `ghcr.io/divij-mot/divij-builder-runtime` and converted into a
Mosaic environment. Registry credentials are needed only for that conversion; Mosaic
unpacks the image once and keeps it, so the running deployment never touches the registry.

## Build and publish

```bash
docker buildx build --platform linux/amd64 \
  -t ghcr.io/divij-mot/divij-builder-runtime:1.1.1 \
  --build-arg RUNTIME_VERSION=1.1.1 --push runtime/

REGISTRY_USERNAME=<user> REGISTRY_PASSWORD=<token-with-read:packages> \
  node scripts/mosaic-build-environment.mjs \
    --image ghcr.io/divij-mot/divij-builder-runtime:1.1.1 \
    --name divij-builder-runtime --replace --verify
```

`--verify` boots the environment twice and runs `builder-selftest` inside a real guest.
Treat a failure there as blocking: it is the only check that exercises the containment in
the environment it actually has to work in.

Locally, `docker run --rm --platform linux/amd64 --privileged <image> builder-selftest`
gets you most of the way, but Docker's kernel is not Firecracker's and the two disagree
about exactly the thing this image cares about (see below).

## Why containment is a network namespace, not a firewall

The obvious design is nftables with an owner match, dropping traffic from the project uid.
Neither half of that works in the Mosaic guest:

- The Firecracker kernel (6.1.177) has **no nf_tables support**. `nft add table inet t`
  returns `Operation not supported`.
- Legacy xtables is present, but its **`xt_owner` module is missing**:
  `iptables-legacy -m owner --uid-owner 1001` fails with
  `Extension owner revision 0 not supported`.

This is worth stating plainly because the failure mode is quiet. Under Docker with
`--privileged` the nftables version worked perfectly; in Mosaic it reported success at the
script level while enforcing nothing. An earlier revision of this image shipped that way
and the selftest caught it only because it tests the *effect* rather than the command's
exit code.

Network namespaces do work, and give a stronger guarantee. Project code runs in a
namespace whose only interface is one end of a veth pair with a /30 and **no default
route**. The internet is not blocked by policy; there is no route to it. DNS fails inside
for the same reason, which is intentional: the proxy resolves names itself and checks
every resolved address against private, loopback, link-local, CGNAT, and metadata ranges,
which is what closes the DNS-rebinding window.

```
root namespace                          builder namespace (no default route)
──────────────                          ────────────────────────────────────
egress-proxy    10.200.0.1:8123  <────  project code, installs, dev server
port-forwarder  0.0.0.0:3000     ────>  10.200.0.2:3000
                                        browser-helper on 10.200.0.2:8124
```

The port forwarder exists because Mosaic's preview connects from the root namespace, so
without it a preview URL would resolve and serve nothing. Only the dev port is bridged —
publishing the proxy or the browser helper would hand the outside world a way around the
allowlist or into the test browser.

## What the selftest actually asserts

`builder-selftest` checks effects, not commands:

- the namespace exists and has **no default route**
- the npm registry is reachable **through the proxy**
- an unapproved host is **refused with 403**
- bypassing the proxy **fails** (`--noproxy '*'`)
- cloud metadata at 169.254.169.254 is **unreachable**
- DNS resolution inside the namespace **fails**
- `builder-run` lands as uid 1001, not root
- the port forwarder is listening for the preview

Run it with `--build` during the image build (toolchain only; no networking or namespaces
exist in a build layer) and with no arguments inside a live sandbox.

## Mosaic behaviours this image works around

**The durable process API does not inherit the image `ENV`, but `exec` does.** A dev
server or build started as a durable process comes up with a bare environment and loses
`NODE_PATH`, `PLAYWRIGHT_BROWSERS_PATH`, and `PNPM_HOME`. Everything here sources
`/etc/builder/runtime.env` instead of trusting what it inherited, so both paths behave
identically.

**ESM ignores `NODE_PATH`.** `browser-helper.mjs` cannot `import 'playwright'` through it,
so `/opt/builder/node_modules` is symlinked to the global module directory. The selftest
checks CJS and ESM resolution separately because passing one says nothing about the other.

**`WORKINGDIR` is dropped; commands start in `/workspace`.** `builder-run --cwd` sets the
directory explicitly rather than relying on the image.

**Long synchronous `exec` calls die at the edge** with a Cloudflare 5xx, so anything slow
runs through the durable process API and the log cursor.

## Layer ordering

`RUNTIME_VERSION` is declared immediately before the one layer that uses it, not at the
top of the file. When it lived up with the other build args, bumping the version
invalidated every layer below it — including the ~2 GB Chromium install — turning a
one-line change into a nine-minute rebuild and re-push. In the current order the same
change takes about eight seconds.

## Files

| Path | Purpose |
| --- | --- |
| `Dockerfile` | The image. |
| `bin/builder-init` | Privileged boot setup: namespace, veth, services. Idempotent. |
| `bin/builder-run` | Runs a command as uid 1001 inside the namespace, with proxy env. Refuses to run at all if the namespace is missing. |
| `bin/builder-selftest` | Toolchain and containment verification. |
| `services/egress-proxy.mjs` | Allowlisting HTTP/CONNECT proxy with DNS and range checks. |
| `services/browser-helper.mjs` | Playwright over HTTP: snapshot, screenshot, click, fill, console, network. |
| `services/port-forwarder.mjs` | Bridges the dev port to the Mosaic preview. |
| `services/proxy-dispatcher.cjs` | Makes Node's `fetch` honour the proxy in generated server code. |
| `policy/egress-allow.default.json` | Baseline allowlist: package registries only. |
