/**
 * In-guest browser automation service.
 *
 * Playwright drives Chromium against http://127.0.0.1:3000 so verification never leaves
 * the sandbox and never depends on the public preview URL being reachable.
 *
 * This process runs inside the contained network namespace alongside the dev server, so
 * it reaches the app over loopback exactly as a real user's browser would, and it has no
 * more internet access than the app does. The control plane reaches it across the veth;
 * it is never published through a Mosaic preview.
 *
 * One browser and one page are kept alive across calls so a multi-step flow (fill a form,
 * submit, assert the result) behaves like a real session. Console messages and failed
 * requests accumulate in ring buffers between reads, which is what lets the agent verify
 * without a screenshot when the model has no vision support.
 */

import http from 'node:http';
import { chromium } from 'playwright';

const PORT = Number(process.env.BUILDER_BROWSER_PORT || 8124);
/**
 * Binds the veth address inside the namespace so the control plane can reach it. Safe as
 * a wildcard here precisely because the namespace has no route to anywhere else -- the
 * only peer that can connect is the root namespace across the /30.
 */
const BIND = process.env.BUILDER_BROWSER_BIND || '0.0.0.0';
const DEV_PORT = Number(process.env.BUILDER_DEV_PORT || 3000);
const MAX_BUFFER = 300;
const DEFAULT_TIMEOUT = 15_000;

let browser = null;
let context = null;
let page = null;
const consoleBuffer = [];
const networkFailures = [];
const pageErrors = [];

function push(buf, entry) {
  buf.push({ ...entry, at: Date.now() });
  if (buf.length > MAX_BUFFER) buf.shift();
}

async function ensurePage() {
  if (browser && context && page && !page.isClosed()) return page;
  if (!browser) {
    browser = await chromium.launch({
      args: [
        '--no-sandbox', // the microVM is the isolation boundary; Chromium's own sandbox needs privileges we drop
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  page = await context.newPage();

  page.on('console', (msg) => {
    push(consoleBuffer, { type: msg.type(), text: msg.text().slice(0, 2000) });
  });
  page.on('pageerror', (err) => {
    push(pageErrors, { message: String(err && err.message).slice(0, 2000) });
  });
  page.on('requestfailed', (req) => {
    push(networkFailures, {
      url: req.url().slice(0, 500),
      method: req.method(),
      failure: req.failure()?.errorText || 'unknown',
    });
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      push(networkFailures, { url: res.url().slice(0, 500), method: res.request().method(), status: res.status() });
    }
  });
  return page;
}

/**
 * Compact semantic snapshot. Interactive nodes get a stable `ref` the agent can act on,
 * which avoids brittle CSS selectors invented by the model.
 */
const SNAPSHOT_SCRIPT = `(() => {
  let counter = 0;
  const lines = [];
  const INTERACTIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','OPTION','LABEL']);
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','PATH','HEAD','META','LINK','TEMPLATE']);

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\\s+/g, ' ').trim();
  }
  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const parts = [role || tag];
    const label =
      el.getAttribute('aria-label') ||
      (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.textContent) ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      ownText(el);
    if (label) parts.push(JSON.stringify(label.slice(0, 120)));
    if (el.tagName === 'INPUT') {
      parts.push('type=' + (el.getAttribute('type') || 'text'));
      if (el.value) parts.push('value=' + JSON.stringify(String(el.value).slice(0, 60)));
    }
    if (el.tagName === 'A' && el.getAttribute('href')) parts.push('href=' + JSON.stringify(el.getAttribute('href').slice(0, 160)));
    if (el.disabled) parts.push('disabled');
    if (el.checked) parts.push('checked');
    return parts.join(' ');
  }
  function walk(el, depth) {
    if (depth > 22 || SKIP.has(el.tagName)) return;
    if (!visible(el)) return;
    const interactive = INTERACTIVE.has(el.tagName) || el.hasAttribute('role') || el.onclick || el.getAttribute('tabindex') !== null;
    const text = ownText(el);
    if (interactive) {
      counter += 1;
      const ref = 'e' + counter;
      el.setAttribute('data-builder-ref', ref);
      lines.push('  '.repeat(depth) + '- [' + ref + '] ' + describe(el));
    } else if (text && text.length > 1) {
      lines.push('  '.repeat(depth) + '- text ' + JSON.stringify(text.slice(0, 200)));
    }
    for (const child of el.children) walk(child, depth + (interactive || text ? 1 : 0));
  }
  document.querySelectorAll('[data-builder-ref]').forEach((n) => n.removeAttribute('data-builder-ref'));
  walk(document.body, 0);
  return {
    url: location.href,
    title: document.title,
    snapshot: lines.slice(0, 600).join('\\n'),
    truncated: lines.length > 600,
  };
})()`;

async function locate(p, { ref, selector, text }) {
  if (ref) return p.locator(`[data-builder-ref="${ref}"]`).first();
  if (selector) return p.locator(selector).first();
  if (text) return p.getByText(text, { exact: false }).first();
  throw new Error('one of ref, selector, or text is required');
}

const actions = {
  async navigate(p, { url, wait_until = 'domcontentloaded' }) {
    const res = await p.goto(url, { waitUntil: wait_until, timeout: DEFAULT_TIMEOUT });
    await p.waitForTimeout(300);
    return { status: res ? res.status() : null, url: p.url() };
  },
  async snapshot(p) {
    return p.evaluate(SNAPSHOT_SCRIPT);
  },
  async screenshot(p, { full_page = false }) {
    const buf = await p.screenshot({ fullPage: full_page, type: 'jpeg', quality: 68 });
    return { image_base64: buf.toString('base64'), mime: 'image/jpeg', url: p.url() };
  },
  async click(p, args) {
    const el = await locate(p, args);
    await el.click({ timeout: DEFAULT_TIMEOUT });
    await p.waitForTimeout(400);
    return { url: p.url() };
  },
  async fill(p, args) {
    const el = await locate(p, args);
    await el.fill(String(args.value ?? ''), { timeout: DEFAULT_TIMEOUT });
    return { url: p.url() };
  },
  async press(p, { key, ...args }) {
    if (args.ref || args.selector || args.text) {
      const el = await locate(p, args);
      await el.press(key, { timeout: DEFAULT_TIMEOUT });
    } else {
      await p.keyboard.press(key);
    }
    await p.waitForTimeout(400);
    return { url: p.url() };
  },
  async resize(p, { width, height }) {
    await p.setViewportSize({ width: Number(width), height: Number(height) });
    await p.waitForTimeout(200);
    return { viewport: p.viewportSize() };
  },
  async wait_for(p, { text, selector, timeout_ms = DEFAULT_TIMEOUT }) {
    if (selector) await p.locator(selector).first().waitFor({ timeout: timeout_ms });
    else if (text) await p.getByText(text, { exact: false }).first().waitFor({ timeout: timeout_ms });
    else await p.waitForLoadState('networkidle', { timeout: timeout_ms });
    return { url: p.url() };
  },
  async console_logs(p, { drain = true }) {
    const entries = [...consoleBuffer];
    if (drain) consoleBuffer.length = 0;
    const errs = [...pageErrors];
    if (drain) pageErrors.length = 0;
    return { console: entries, page_errors: errs };
  },
  async network_failures(p, { drain = true }) {
    const entries = [...networkFailures];
    if (drain) networkFailures.length = 0;
    return { failures: entries };
  },
  async inspect(p) {
    return {
      url: p.url(),
      title: await p.title(),
      viewport: p.viewportSize(),
      console_count: consoleBuffer.length,
      failure_count: networkFailures.length,
    };
  },
  async reset() {
    if (context) await context.close().catch(() => {});
    context = null;
    page = null;
    consoleBuffer.length = 0;
    networkFailures.length = 0;
    pageErrors.length = 0;
    await ensurePage();
    return { reset: true };
  },
};

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  };

  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, browser: Boolean(browser), version: process.env.BUILDER_RUNTIME_VERSION || 'dev' });
  }
  if (req.method !== 'POST' || req.url !== '/act') return send(404, { error: 'not_found' });

  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 4 * 1024 * 1024) req.destroy();
  });
  req.on('end', async () => {
    let args;
    try {
      args = JSON.parse(body || '{}');
    } catch {
      return send(400, { error: 'invalid_json' });
    }
    const fn = actions[args.action];
    if (!fn) return send(400, { error: 'unknown_action', action: args.action });
    try {
      const p = args.action === 'reset' ? null : await ensurePage();
      const result = await fn(p, args);
      send(200, { ok: true, action: args.action, ...result });
    } catch (err) {
      send(200, { ok: false, action: args.action, error: String(err && err.message).slice(0, 1200) });
    }
  });
});

server.listen(PORT, BIND, () => {
  process.stdout.write(`browser-helper listening on ${BIND}:${PORT} (app expected on 127.0.0.1:${DEV_PORT})\n`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await browser?.close().catch(() => {});
    process.exit(0);
  });
}
