/**
 * In-guest allowlisting egress proxy.
 *
 * Project code runs in a network namespace whose only route is a /30 to this process, so
 * this is the sole path from project code to the internet. That containment is structural
 * rather than a firewall rule: the guest kernel has no nf_tables and no xt_owner module,
 * so there is no way to express "drop traffic from this uid" -- but a namespace with no
 * default route cannot reach anything regardless of policy.
 *
 * This process runs in the root namespace as its own `egress` uid, and makes three
 * guarantees the namespace alone cannot:
 *
 *   1. Only allowlisted hostnames are reachable. The npm registry ships allowed; every
 *      application host is added at runtime by /api/builder/egress/allow after the user
 *      approves it.
 *   2. Names are resolved here, and every resolved address is checked against private,
 *      loopback, link-local, CGNAT, reserved, and cloud-metadata ranges. The socket then
 *      connects to the validated address rather than re-resolving, which closes the DNS
 *      rebinding window.
 *   3. Sessions are bounded by connection count, byte budget, and duration.
 *
 * Logs carry hostname, status, and byte counts. Never paths, bodies, headers, or credentials.
 */

import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import { isIP } from 'node:net';

const PORT = Number(process.env.BUILDER_EGRESS_PORT || 8123);
/**
 * Binds the veth address, which is the only address the contained namespace can reach.
 * Never 0.0.0.0 in production: the guest's outward-facing interface is in this namespace,
 * so a wildcard bind would publish an open forward proxy to anyone who found the port.
 */
const BIND = process.env.BUILDER_EGRESS_BIND || '10.200.0.1';
const POLICY_PATH = process.env.BUILDER_EGRESS_POLICY || '/etc/builder/egress-allow.json';
const LOG_PATH = process.env.BUILDER_EGRESS_LOG || '/var/log/builder/egress.log';

const DEFAULT_LIMITS = {
  max_concurrent_connections: 64,
  max_connections_per_session: 5000,
  max_bytes_per_session: 2 * 1024 * 1024 * 1024,
  max_connection_seconds: 900,
  allowed_ports: [443],
};

let policy = { allow: [], allow_http: [], limits: { ...DEFAULT_LIMITS } };
const session = { connections: 0, bytes: 0, active: 0, startedAt: Date.now() };

function loadPolicy() {
  try {
    const raw = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    policy = {
      allow: Array.isArray(raw.allow) ? raw.allow.map((h) => String(h).toLowerCase()) : [],
      allow_http: Array.isArray(raw.allow_http) ? raw.allow_http.map((h) => String(h).toLowerCase()) : [],
      limits: { ...DEFAULT_LIMITS, ...(raw.limits || {}) },
    };
  } catch (err) {
    log({ event: 'policy_load_failed', reason: err.code || 'parse_error' });
  }
}

function log(fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...fields });
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {
    /* logging must never break the proxy */
  }
  process.stdout.write(line + '\n');
}

/** Suffix match on label boundaries: "api.example.com" matches an "example.com" entry. */
function hostAllowed(host, list) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return list.some((entry) => {
    if (entry.startsWith('*.')) {
      const base = entry.slice(2);
      return h === base || h.endsWith('.' + base);
    }
    return h === entry || h.endsWith('.' + entry);
  });
}

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** Reject anything that is not a public unicast destination. */
function isForbiddenAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    const inRange = (cidr, bits) => (n >>> (32 - bits)) === (ipv4ToInt(cidr) >>> (32 - bits));
    return (
      inRange('0.0.0.0', 8) ||          // "this network"
      inRange('10.0.0.0', 8) ||         // private
      inRange('100.64.0.0', 10) ||      // CGNAT
      inRange('127.0.0.0', 8) ||        // loopback
      inRange('169.254.0.0', 16) ||     // link-local, includes 169.254.169.254 metadata
      inRange('172.16.0.0', 12) ||      // private
      inRange('192.0.0.0', 24) ||       // IETF protocol assignments
      inRange('192.0.2.0', 24) ||       // TEST-NET-1
      inRange('192.168.0.0', 16) ||     // private
      inRange('198.18.0.0', 15) ||      // benchmarking
      inRange('198.51.100.0', 24) ||    // TEST-NET-2
      inRange('203.0.113.0', 24) ||     // TEST-NET-3
      n >= ipv4ToInt('224.0.0.0')       // multicast, reserved, broadcast
    );
  }
  if (v === 6) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (a === '::' || a === '::1') return true;
    if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true; // link-local, ULA
    if (a.startsWith('ff')) return true; // multicast
    // IPv4-mapped (::ffff:a.b.c.d) must be judged by its embedded v4 address.
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isForbiddenAddress(mapped[1]);
    if (a === '64:ff9b::' || a.startsWith('64:ff9b:')) return true; // NAT64
    return false;
  }
  return true;
}

async function resolveSafely(host) {
  if (isIP(host)) {
    // A literal address gets no name-resolution step, but the same range check.
    if (isForbiddenAddress(host)) throw Object.assign(new Error('forbidden_address'), { code: 'forbidden_address' });
    return host;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error('dns_failure'), { code: 'dns_failure' });
  }
  if (!records.length) throw Object.assign(new Error('dns_empty'), { code: 'dns_failure' });
  // Every answer must be public. One private answer poisons the name, which is what
  // stops an attacker-controlled domain from pointing a single A record at 169.254.169.254.
  for (const r of records) {
    if (isForbiddenAddress(r.address)) {
      throw Object.assign(new Error('forbidden_address'), { code: 'forbidden_address' });
    }
  }
  return records[0].address;
}

function overBudget() {
  const l = policy.limits;
  if (session.active >= l.max_concurrent_connections) return 'too_many_concurrent';
  if (session.connections >= l.max_connections_per_session) return 'connection_budget_exhausted';
  if (session.bytes >= l.max_bytes_per_session) return 'byte_budget_exhausted';
  return null;
}

function meter(socket, host) {
  let bytes = 0;
  const add = (chunk) => {
    bytes += chunk.length;
    session.bytes += chunk.length;
  };
  socket.on('data', add);
  return {
    finish: (status) => log({ event: 'egress', host, status, bytes }),
  };
}

const server = http.createServer();

// Plain HTTP proxying. Only hosts explicitly approved for port 80 are eligible;
// everything else must use CONNECT over 443.
server.on('request', async (req, res) => {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const host = target.hostname;
  const port = Number(target.port || 80);
  const deny = (status, reason) => {
    log({ event: 'egress_denied', host, port, reason });
    res.writeHead(status, { 'content-type': 'text/plain' }).end(reason);
  };

  if (port !== 80) return deny(403, 'port_not_allowed');
  if (!hostAllowed(host, policy.allow_http)) return deny(403, 'host_not_allowed');
  const budget = overBudget();
  if (budget) return deny(429, budget);

  let address;
  try {
    address = await resolveSafely(host);
  } catch (e) {
    return deny(403, e.code || 'resolve_failed');
  }

  session.connections += 1;
  session.active += 1;
  const m = meter(req, host);
  const upstream = http.request(
    {
      host: address,
      port,
      method: req.method,
      path: target.pathname + target.search,
      // Preserve the name for virtual hosting even though we dialled the address.
      headers: { ...req.headers, host: target.host },
      timeout: policy.limits.max_connection_seconds * 1000,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.on('data', (c) => {
        session.bytes += c.length;
      });
      up.pipe(res);
      up.on('end', () => {
        session.active -= 1;
        m.finish(up.statusCode);
      });
    },
  );
  upstream.on('error', () => {
    session.active -= 1;
    m.finish('upstream_error');
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

// HTTPS (and any TLS) via CONNECT. The proxy never sees plaintext or credentials.
server.on('connect', async (req, clientSocket, head) => {
  const [rawHost, rawPort] = req.url.split(':');
  const host = (rawHost || '').replace(/^\[|\]$/g, '');
  const port = Number(rawPort || 443);
  const deny = (reason, code = 403) => {
    log({ event: 'egress_denied', host, port, reason });
    clientSocket.end(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
  };

  if (!policy.limits.allowed_ports.includes(port)) return deny('port_not_allowed');
  if (!hostAllowed(host, policy.allow)) return deny('host_not_allowed');
  const budget = overBudget();
  if (budget) return deny(budget, 429);

  let address;
  try {
    address = await resolveSafely(host);
  } catch (e) {
    return deny(e.code || 'resolve_failed');
  }

  session.connections += 1;
  session.active += 1;
  let bytes = 0;
  const count = (c) => {
    bytes += c.length;
    session.bytes += c.length;
    if (session.bytes > policy.limits.max_bytes_per_session) {
      upstream.destroy();
      clientSocket.destroy();
    }
  };

  const upstream = net.connect(port, address, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const hardStop = setTimeout(() => {
    upstream.destroy();
    clientSocket.destroy();
  }, policy.limits.max_connection_seconds * 1000);

  upstream.on('data', count);
  clientSocket.on('data', count);

  const done = (status) => {
    clearTimeout(hardStop);
    if (!done.called) {
      done.called = true;
      session.active -= 1;
      log({ event: 'egress', host, port, status, bytes });
    }
  };
  upstream.on('error', () => {
    done('upstream_error');
    clientSocket.destroy();
  });
  clientSocket.on('error', () => {
    done('client_error');
    upstream.destroy();
  });
  upstream.on('close', () => done('closed'));
});

loadPolicy();
try {
  fs.watch(POLICY_PATH, { persistent: false }, () => setTimeout(loadPolicy, 50));
} catch {
  setInterval(loadPolicy, 5000).unref();
}

server.listen(PORT, BIND, () => {
  log({ event: 'proxy_listening', bind: BIND, port: PORT, allow_count: policy.allow.length });
});
