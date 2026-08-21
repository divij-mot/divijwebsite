import { describe, expect, it } from 'vitest';

import { embeddableFromHeaders } from '../../../api/_lib/previewEmbed.js';

describe('preview embeddable headers', () => {
  it('allows framing when no denying headers are present', () => {
    expect(embeddableFromHeaders(new Headers({ 'content-type': 'text/html' }))).toBe(true);
  });

  it('rejects X-Frame-Options: DENY, which Mosaic currently sends on preview URLs', () => {
    expect(embeddableFromHeaders(new Headers({ 'x-frame-options': 'DENY' }))).toBe(false);
  });

  it('rejects X-Frame-Options: SAMEORIGIN, because we are not mosaicos.com', () => {
    expect(embeddableFromHeaders(new Headers({ 'x-frame-options': 'SAMEORIGIN' }))).toBe(false);
  });

  it("rejects CSP frame-ancestors 'none'", () => {
    expect(
      embeddableFromHeaders(
        new Headers({
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        }),
      ),
    ).toBe(false);
  });

  it('allows a CSP that does not mention frame-ancestors', () => {
    expect(
      embeddableFromHeaders(new Headers({ 'content-security-policy': "default-src 'self'" })),
    ).toBe(true);
  });
});
