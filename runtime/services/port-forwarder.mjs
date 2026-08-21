/**
 * Bridges the dev port from the root network namespace into the builder namespace.
 *
 * The dev server runs inside the contained namespace, but Mosaic's preview connects from
 * the root namespace, so without this the preview would find nothing listening. A plain
 * TCP relay is used rather than NAT because the guest kernel has no nf_tables and no
 * xt_owner, so there is no usable netfilter path here.
 *
 * Only the dev port is bridged. The egress proxy and the browser helper are deliberately
 * not exposed this way -- publishing either would hand the outside world a way around the
 * allowlist or into the test browser.
 */

import net from 'node:net';

const LISTEN_PORT = Number(process.env.BUILDER_DEV_PORT || 3000);
const TARGET_HOST = process.env.BUILDER_GUEST_IP || '10.200.0.2';
const TARGET_PORT = LISTEN_PORT;
const MAX_CONNECTIONS = 512;

let active = 0;

const server = net.createServer((client) => {
  if (active >= MAX_CONNECTIONS) {
    client.destroy();
    return;
  }
  active += 1;

  const upstream = net.connect(TARGET_PORT, TARGET_HOST);
  const shutdown = () => {
    if (!client.destroyed) client.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };

  upstream.on('connect', () => {
    client.pipe(upstream);
    upstream.pipe(client);
  });

  // A dev server that is restarting refuses connections for a few seconds. Closing
  // quietly lets the browser retry, instead of logging a stack trace per reload.
  upstream.on('error', shutdown);
  client.on('error', shutdown);

  const release = () => {
    active = Math.max(0, active - 1);
  };
  client.once('close', () => {
    release();
    shutdown();
  });
  upstream.once('close', shutdown);
});

server.on('error', (err) => {
  process.stderr.write(`port-forwarder error: ${err.message}\n`);
  if (err.code === 'EADDRINUSE') process.exit(1);
});

server.listen(LISTEN_PORT, process.env.BUILDER_EGRESS_BIND || '0.0.0.0', () => {
  process.stdout.write(`port-forwarder ${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}\n`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
