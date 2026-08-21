import { describe, expect, it } from 'vitest';

import {
  copyUpstreamHeaders,
  frameAncestorsHeader,
  isMosaicGatewayError,
  isPreviewId,
  mosaicPreviewTarget,
  otherOrigin,
  previewIdFromUrl,
  rewriteGuestHtml,
  rewriteLocation,
} from '../../../api/_lib/previewFrame.js';

const req = (host: string, extra: { headers?: Record<string, string>; encrypted?: boolean } = {}) => ({
  headers: { host, ...(extra.headers ?? {}) },
  socket: extra.encrypted ? { encrypted: true } : {},
});

describe('preview id', () => {
  it('extracts the Mosaic path token', () => {
    expect(
      previewIdFromUrl(
        'https://sandbox.mosaicos.com/preview/c933752070114fec9bac9de755d6133c824d9ff4a06241b8b230ea1d007a4af2/',
      ),
    ).toBe('c933752070114fec9bac9de755d6133c824d9ff4a06241b8b230ea1d007a4af2');
  });

  it('rejects short or dotted ids so the proxy cannot be aimed at another host', () => {
    expect(isPreviewId('abc')).toBe(false);
    expect(isPreviewId('../etc/passwd')).toBe(false);
    expect(isPreviewId('https://evil.example')).toBe(false);
    expect(isPreviewId('c933752070114fec9bac9de755d6133c824d9ff4a06241b8b230ea1d007a4af2')).toBe(true);
  });
});

describe('sibling origin', () => {
  it('pairs localhost with 127.0.0.1 on the same port', () => {
    expect(otherOrigin(req('localhost:4186'))).toBe('http://127.0.0.1:4186');
    expect(otherOrigin(req('127.0.0.1:4186'))).toBe('http://localhost:4186');
  });

  it('pairs a custom domain with the Vercel deployment host', () => {
    const prev = process.env.VERCEL_URL;
    process.env.VERCEL_URL = 'divij-website-abc.vercel.app';
    try {
      expect(otherOrigin(req('divijmotwani.com', { headers: { 'x-forwarded-proto': 'https' } }))).toBe(
        'https://divij-website-abc.vercel.app',
      );
    } finally {
      process.env.VERCEL_URL = prev;
    }
  });

  it('lists the parent origin as a frame ancestor', () => {
    expect(frameAncestorsHeader(req('127.0.0.1:4186'))).toContain('http://localhost:4186');
  });
});

describe('proxy target', () => {
  it('only ever points at Mosaic preview URLs', () => {
    const id = 'c933752070114fec9bac9de755d6133c824d9ff4a06241b8b230ea1d007a4af2';
    expect(mosaicPreviewTarget(id, '/', '')).toBe(`https://sandbox.mosaicos.com/preview/${id}/`);
    expect(mosaicPreviewTarget(id, '/_next/static/chunks/main.js', '')).toBe(
      `https://sandbox.mosaicos.com/preview/${id}/_next/static/chunks/main.js`,
    );
  });

  it('rewrites Mosaic Location headers onto the prefixed proxy path', () => {
    const id = 'c933752070114fec9bac9de755d6133c824d9ff4a06241b8b230ea1d007a4af2';
    expect(rewriteLocation(`https://sandbox.mosaicos.com/preview/${id}/login`, id)).toBe(`/__p/${id}/login`);
  });

  it('prefixes guest HTML so scripts load without a third-party cookie', () => {
    const id = 'c933752070114fec9bac9de755d6133c824d9ff4a06241b8b230ea1d007a4af2';
    const html = rewriteGuestHtml(
      '<head></head><script src="/_next/static/chunks/main.js"></script>',
      id,
    );
    expect(html).toContain(`/__p/${id}/_next/static/chunks/main.js`);
    expect(html).not.toContain('src="/_next/');
    expect(html).toContain('history.replaceState');
  });

  it('recognizes Cloudflare 502 HTML from a dead Mosaic preview origin', () => {
    expect(isMosaicGatewayError(200, '<html>Todo</html>')).toBe(false);
    expect(
      isMosaicGatewayError(
        502,
        '<title>mosaicos.com | 502: Bad gateway</title><p>Performance & security by Cloudflare</p>',
      ),
    ).toBe(true);
  });

  it('drops X-Frame-Options so the iframe can render', () => {
    const out = copyUpstreamHeaders(
      new Headers({
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
        'content-type': 'text/html',
      }),
      { 'content-security-policy': 'frame-ancestors http://localhost:4186' },
    ) as Record<string, string>;
    expect(out['x-frame-options']).toBeUndefined();
    expect(out['content-type']).toBe('text/html');
    expect(out['content-security-policy']).toBe('frame-ancestors http://localhost:4186');
  });
});
