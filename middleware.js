/**
 * Route sibling-origin preview traffic to the Mosaic reverse proxy.
 *
 * vercel.json `has` (cookie / host conditions) is ignored by `vercel dev`, so this
 * middleware is what makes `/__p/<token>/...` reach the proxy locally. The guest HTML
 * is rewritten so `/_next` assets stay under that prefix — Chrome treats localhost and
 * 127.0.0.1 as different sites, so a cookie on the iframe origin is not reliable.
 */

import { next, rewrite } from '@vercel/functions';

const COOKIE = 'builder_frame';

export const config = {
  matcher: ['/__p/:path*', '/((?!api/|src/|@|node_modules/|assets/).*)'],
};

export default function middleware(request) {
  const url = new URL(request.url);
  const cookie = request.headers.get('cookie') || '';
  const hasFrame = new RegExp(`(?:^|;\\s*)${COOKIE}=`).test(cookie);
  const isEntry = url.pathname === '/__p' || url.pathname.startsWith('/__p/');
  const reserved =
    url.pathname === '/builder' ||
    url.pathname.startsWith('/builder/') ||
    url.pathname.startsWith('/api/');

  if (reserved && !isEntry) return next();
  if (!isEntry && !hasFrame) return next();

  const dest = new URL('/api/builder/frame', url.origin);
  dest.search = url.search;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === '__p' && parts[1]) {
    dest.searchParams.set('id', parts[1]);
    dest.searchParams.set('path', parts.length > 2 ? `/${parts.slice(2).join('/')}` : '/');
  } else {
    dest.searchParams.set('path', url.pathname);
  }
  return rewrite(dest);
}
