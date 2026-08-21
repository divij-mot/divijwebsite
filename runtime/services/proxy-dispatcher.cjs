/**
 * Preloaded into every process started by builder-run.
 *
 * Node's global fetch is undici, and undici ignores HTTPS_PROXY unless it is told to use
 * a ProxyAgent. Without this, server-side fetch in generated code would bypass the
 * allowlist and hit the firewall as an unexplained connection reset. NODE_USE_ENV_PROXY
 * covers newer runtimes; this covers the rest.
 *
 * Failure is deliberately silent: the firewall, not this file, is the containment
 * boundary, and a preload crash would break every command in the sandbox.
 */

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxy && !process.env.BUILDER_DISABLE_PROXY_DISPATCHER) {
  try {
    // Available since Node 18 as a built-in; falls back to a project-local install.
    const undici = require('node:undici');
    if (undici?.setGlobalDispatcher && undici?.ProxyAgent) {
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
    }
  } catch {
    try {
      const undici = require('undici');
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
    } catch {
      /* NODE_USE_ENV_PROXY or the firewall handles it from here */
    }
  }
}
