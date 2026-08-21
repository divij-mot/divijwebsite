/**
 * Sibling-origin preview framing.
 *
 * Mosaic preview URLs return the guest HTML but attach the control-plane's
 * `X-Frame-Options: DENY` and `frame-ancestors 'none'`, so a browser will not render
 * them in an iframe. We reverse-proxy the guest through our own host and strip those
 * headers.
 *
 * The proxy cannot share an origin with the builder: an iframe with `allow-scripts` and
 * `allow-same-origin` on the builder's origin could reach `parent.document` and the
 * session cookie. Locally `localhost` and `127.0.0.1` are different origins on the same
 * server. In production the deployment's `*.vercel.app` host is paired with the custom
 * domain. The iframe always loads the other one.
 *
 * Guest apps request `/_next/...` from the origin root, not under `/__p/<id>/`, so the
 * first `/__p/<id>/` response sets a host-only cookie and later paths on that host are
 * proxied too.
 */

export const FRAME_COOKIE = 'builder_frame';
export const PREVIEW_ID_RE = /^[a-zA-Z0-9_-]{16,128}$/;
export const MOSAIC_PREVIEW_ORIGIN = 'https://sandbox.mosaicos.com';

export function previewIdFromUrl(url) {
  if (!url) return '';
  try {
    const path = new URL(url).pathname;
    const m = /\/preview\/([a-zA-Z0-9_-]+)/.exec(path);
    return m?.[1] || '';
  } catch {
    return '';
  }
}

export function isPreviewId(id) {
  return typeof id === 'string' && PREVIEW_ID_RE.test(id);
}

export function parseHostHeader(hostHeader) {
  const raw = String(hostHeader || '').trim();
  if (!raw) return { hostname: '', port: '' };
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return { hostname: raw.slice(0, end + 1), port: raw.slice(end + 2) };
  }
  const i = raw.lastIndexOf(':');
  if (i === -1) return { hostname: raw, port: '' };
  return { hostname: raw.slice(0, i), port: raw.slice(i + 1) };
}

function requestProto(req) {
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return req.socket?.encrypted ? 'https' : 'http';
}

function requestHost(req) {
  return String(req.headers?.['x-forwarded-host'] || req.headers?.host || '');
}

function withPort(hostname, port) {
  return port ? `${hostname}:${port}` : hostname;
}

function productionHost() {
  const raw =
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.PREVIEW_PARENT_ORIGIN || 'www.divijmotwani.com';
  return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Unique Vercel URLs (`project-hash-team.vercel.app`) are behind Deployment Protection
 * and send `X-Frame-Options: DENY` on the SSO interstitial. The production alias
 * (`project.vercel.app`) is public and can actually be framed.
 */
export function publicDeploymentHost(vercelUrl) {
  const host = String(vercelUrl || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  if (!host.endsWith('.vercel.app')) return host;
  const name = host.slice(0, -'.vercel.app'.length);
  const parts = name.split('-');
  // Unique URLs are `{project}-{hash}-{team}`. The hash is 8–12 alphanumeric and
  // always contains a digit, which is what distinguishes `36d5cpba9` from `developer`.
  for (let i = 1; i < parts.length - 1; i += 1) {
    const hash = parts[i];
    if (hash.length >= 8 && hash.length <= 12 && /\d/.test(hash) && /^[a-z0-9]+$/i.test(hash)) {
      const project = parts.slice(0, i).join('-');
      if (project) return `${project}.vercel.app`;
    }
  }
  return host;
}

/**
 * The origin the iframe should use, given a request that came from the builder page
 * (or from the iframe itself — the two are swapped).
 */
export function otherOrigin(req) {
  const override = (process.env.PREVIEW_FRAME_ORIGIN || '').replace(/\/$/, '');
  const proto = requestProto(req);
  const { hostname, port } = parseHostHeader(requestHost(req));

  if (hostname === 'localhost') return `${proto}://${withPort('127.0.0.1', port)}`;
  if (hostname === '127.0.0.1') return `${proto}://${withPort('localhost', port)}`;

  if (override) {
    const overrideHost = override.replace(/^https?:\/\//, '');
    if (overrideHost && overrideHost !== hostname) {
      return override.startsWith('http') ? override : `https://${overrideHost}`;
    }
  }

  const production = productionHost();
  const alias = publicDeploymentHost(process.env.VERCEL_URL);

  // *.vercel.app frames the custom domain. Custom domains frame the public alias,
  // never the unique deployment URL (that one is SSO-protected).
  if (hostname.endsWith('.vercel.app')) {
    return `https://${production}`;
  }
  if (alias) {
    return `https://${alias}`;
  }
  if (hostname.startsWith('www.')) return `${proto}://${withPort(hostname.slice(4), port)}`;
  return `${proto}://${withPort(`www.${hostname}`, port)}`;
}

export function frameAncestorsHeader(req) {
  const parent = otherOrigin(req);
  const extras = (process.env.BUILDER_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('http') ? s : `https://${s}`));
  const listed = [parent, 'http://localhost:*', 'http://127.0.0.1:*', ...extras];
  return [...new Set(listed)].join(' ');
}

export function mosaicPreviewTarget(previewId, path, search = '') {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const suffix = search && search !== '?' ? (search.startsWith('?') ? search : `?${search}`) : '';
  return `${MOSAIC_PREVIEW_ORIGIN}/preview/${previewId}${cleanPath === '/' ? '/' : cleanPath}${suffix}`;
}

const SKIP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
  'set-cookie2',
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'alt-svc',
  'report-to',
  'nel',
  'clear-site-data',
]);

export function copyUpstreamHeaders(upstreamHeaders, out) {
  const headers = {};
  for (const [key, value] of upstreamHeaders.entries()) {
    if (SKIP_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  Object.assign(headers, out);
  return headers;
}

export function rewriteLocation(location, previewId) {
  if (!location) return location;
  try {
    const u = new URL(location, `${MOSAIC_PREVIEW_ORIGIN}/preview/${previewId}/`);
    const prefix = `/preview/${previewId}`;
    if (u.hostname === 'sandbox.mosaicos.com' && (u.pathname === prefix || u.pathname.startsWith(`${prefix}/`))) {
      const rest = u.pathname.slice(prefix.length) || '/';
      return `/__p/${previewId}${rest}${u.search}${u.hash}`;
    }
  } catch {
    /* keep original */
  }
  if (location.startsWith('/') && !location.startsWith('/__p/')) {
    return `/__p/${previewId}${location}`;
  }
  return location;
}

export function rewriteGuestHtml(html, previewId) {
  const prefix = `/__p/${previewId}`;
  const rewritten = html.replace(/(["'`])\/_next\//g, `$1${prefix}/_next/`);
  const boot = `<script>(function(){var p=${JSON.stringify(prefix)};function abs(u){if(typeof u!=="string")return u;if(u.startsWith(p)||/^[a-z]+:/i.test(u)||u.startsWith("//"))return u;if(u.startsWith("/"))return p+u;return u}var f=window.fetch;window.fetch=function(input,init){if(typeof input==="string")input=abs(input);else if(input&&typeof input.url==="string")input=new Request(abs(input.url),input);return f.call(this,input,init)};var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=abs(String(u));return o.apply(this,arguments)};try{history.replaceState(null,"","/")}catch(e){}})();</script>`;
  if (/<head[^>]*>/i.test(rewritten)) return rewritten.replace(/<head[^>]*>/i, (m) => `${m}${boot}`);
  return `${boot}${rewritten}`;
}

export function rewriteGuestCss(css, previewId) {
  return css.replaceAll('/_next/', `/__p/${previewId}/_next/`);
}

export function isMosaicGatewayError(status, html) {
  const gateway =
    status === 502 ||
    status === 520 ||
    status === 521 ||
    status === 522 ||
    status === 523 ||
    status === 524 ||
    status === 525 ||
    status === 530;
  if (!gateway) return false;
  if (typeof html !== 'string' || html.length === 0) return true;
  return /cloudflare|bad gateway|error code 50|mosaicos\.com|sandbox-origin-mar-/i.test(html);
}

export async function previewUrlReachable(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/html')) return true;
    const html = await res.text();
    return !isMosaicGatewayError(res.status, html);
  } catch {
    return false;
  }
}

export function gatewayErrorHtml(status) {
  const code = Number(status) || 502;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Preview unavailable</title>
  <style>
    html, body { margin: 0; height: 100%; background: #0a0a0a; color: #e5e5e5; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
    main { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; text-align: center; }
    h1 { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
    p { margin: 0; max-width: 28rem; color: #a3a3a3; }
  </style>
</head>
<body>
  <main>
    <h1>The sandbox preview is down</h1>
    <p>Mosaic returned ${code} from the preview origin. The builder is fine — hit refresh in the preview bar to mint a new URL, or wait a minute and try again.</p>
  </main>
</body>
</html>`;
}

export function frameCookie(previewId, { secure }) {
  return [
    `${FRAME_COOKIE}=${previewId}`,
    'Path=/',
    'SameSite=Lax',
    'HttpOnly',
    'Max-Age=3600',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}
