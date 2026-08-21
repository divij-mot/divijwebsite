/**
 * Reverse-proxy a Mosaic preview so it can live in the builder iframe.
 *
 * See api/_lib/previewFrame.js for why this exists and why it is served from a sibling
 * origin rather than the builder's own host.
 *
 * Auth is the unguessable preview id, not the session cookie: `__Host-` cookies set on
 * localhost are not sent to 127.0.0.1, which is the point of the origin split.
 */

import { Readable } from 'node:stream';

import {
  FRAME_COOKIE,
  copyUpstreamHeaders,
  frameAncestorsHeader,
  frameCookie,
  gatewayErrorHtml,
  isMosaicGatewayError,
  isPreviewId,
  mosaicPreviewTarget,
  rewriteGuestCss,
  rewriteGuestHtml,
  rewriteLocation,
} from '../_lib/previewFrame.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
  api: { bodyParser: false },
};

const RESERVED = /^(?:\/api\/builder(?:\/|$)|\/builder(?:\/|$)|\/assets\/|\/src\/|\/@|\/node_modules\/)/;

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function incomingPathAndSearch(req) {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);
  const idFromQuery = url.searchParams.get('id') || '';
  let path = url.searchParams.get('path');
  url.searchParams.delete('id');
  url.searchParams.delete('path');

  if (path == null) {
    path = url.pathname;
    const m = /^\/__p\/[^/]+(\/.*)?$/.exec(path);
    if (m) path = m[1] || '/';
  }

  if (!path.startsWith('/')) path = `/${path}`;
  return { idFromQuery, path, search: url.search };
}

function requestProto(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return req.socket?.encrypted ? 'https' : 'http';
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 20 * 1024 * 1024) {
      const err = new Error('body too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  try {
    const { idFromQuery, path, search } = incomingPathAndSearch(req);
    const id = idFromQuery || cookieValue(req.headers.cookie, FRAME_COOKIE);

    if (!isPreviewId(id)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('No preview.');
      return;
    }

    if (RESERVED.test(path)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not a preview path.');
      return;
    }

    const guestPath = path.startsWith('/__p/') ? '/' : path;
    const target = mosaicPreviewTarget(id, guestPath, search);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value || key === 'host' || key === 'connection' || key === 'content-length') continue;
      if (key === 'cookie') continue;
      headers.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    headers.set('accept-encoding', 'identity');
    headers.set('host', 'sandbox.mosaicos.com');

    const body = await readBody(req);
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });

    const extra = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `frame-ancestors ${frameAncestorsHeader(req)}`,
      'referrer-policy': 'no-referrer',
      // The builder page uses COEP require-corp (FFmpeg / SharedArrayBuffer), so a
      // cross-origin iframe is blocked unless the framed document opts in.
      'cross-origin-resource-policy': 'cross-origin',
      'set-cookie': frameCookie(id, { secure: requestProto(req) === 'https' }),
    };

    const location = rewriteLocation(upstream.headers.get('location'), id);
    const outHeaders = copyUpstreamHeaders(upstream.headers, extra);
    if (location) outHeaders.location = location;

    const contentType = String(upstream.headers.get('content-type') || '');
    const rewriteHtml = contentType.includes('text/html');
    const rewriteCss = contentType.includes('text/css');

    if (rewriteHtml || rewriteCss) {
      const text = await upstream.text();
      if (rewriteHtml && isMosaicGatewayError(upstream.status, text)) {
        res.statusCode = 502;
        for (const [key, value] of Object.entries(outHeaders)) {
          if (key.toLowerCase() === 'content-length') continue;
          res.setHeader(key, value);
        }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(gatewayErrorHtml(upstream.status));
        return;
      }
      const rewritten = rewriteHtml ? rewriteGuestHtml(text, id) : rewriteGuestCss(text, id);
      outHeaders['content-type'] = contentType;
      res.statusCode = upstream.status === 0 ? 502 : upstream.status;
      for (const [key, value] of Object.entries(outHeaders)) {
        if (key.toLowerCase() === 'content-length') continue;
        res.setHeader(key, value);
      }
      res.end(rewritten);
      return;
    }

    res.statusCode = upstream.status === 0 ? 502 : upstream.status;
    for (const [key, value] of Object.entries(outHeaders)) {
      res.setHeader(key, value);
    }

    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    res.statusCode = err.statusCode || 502;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Preview proxy failed.');
  }
}
