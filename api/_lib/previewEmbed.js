/**
 * Whether a Mosaic preview URL can be put in an iframe.
 *
 * Mosaic currently copies the control-plane security headers onto preview responses,
 * including `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`. The guest HTML is
 * in the body and works in a top-level tab; the same URL in a sandboxed iframe is blank.
 * This helper is how the UI knows to offer "open in a new tab" instead of a white pane.
 */

export function embeddableFromHeaders(headers) {
  const get = (name) => {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? String(headers[key] ?? '') : '';
  };

  const xfo = get('x-frame-options').trim().toLowerCase();
  if (xfo === 'deny' || xfo === 'sameorigin') return false;

  const csp = get('content-security-policy');
  const ancestors = /(?:^|;)\s*frame-ancestors\s+([^;]+)/i.exec(csp);
  if (!ancestors) return true;
  const list = ancestors[1].trim().toLowerCase();
  if (list === "'none'" || list === '"none"') return false;
  return true;
}

export async function previewEmbeddable(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    return embeddableFromHeaders(res.headers);
  } catch {
    // If we cannot probe, try the iframe. A white pane is recoverable; hiding a working
    // preview because Mosaic was briefly unreachable is not.
    return true;
  }
}
