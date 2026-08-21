/**
 * POST   /api/builder/auth  -- exchange an invite code for a beta session
 * DELETE /api/builder/auth  -- sign out
 * GET    /api/builder/auth  -- report whether the caller has a valid session
 *
 * The invite code is compared by hash and never stored in plaintext. The session cookie
 * carries only that hash and an issue time; nothing about the user's project touches the
 * server here or anywhere else.
 */

import {
  HttpError,
  clearCookie,
  clientIp,
  assertSameOrigin,
  issueSession,
  readJsonBody,
  sendError,
  sendJson,
  sessionCookie,
  verifySession,
  verifyTurnstile,
  COOKIE_NAME,
} from '../_lib/session.js';
import * as store from '../_lib/store.js';

export const config = { runtime: 'nodejs' };

/** Per-IP brute-force ceiling on code guessing, independent of the per-code quota. */
const MAX_ATTEMPTS_PER_HOUR = 20;

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const cookie = (req.headers.cookie || '')
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith(`${COOKIE_NAME}=`));
      const session = cookie ? verifySession(cookie.slice(COOKIE_NAME.length + 1)) : null;
      const revoked = session ? Boolean(await store.get(`invite:revoked:${session.h}`)) : false;
      return sendJson(res, 200, {
        authenticated: Boolean(session) && !revoked,
        durable_store: store.durable,
        turnstile_site_key: process.env.TURNSTILE_SITE_KEY || null,
      });
    }

    if (req.method === 'DELETE') {
      assertSameOrigin(req);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    assertSameOrigin(req);

    if (await store.isKillSwitchOn()) {
      throw new HttpError(503, 'builder_disabled', 'The builder is temporarily disabled.');
    }

    const ip = clientIp(req);
    const attempts = await store.incrementWithTtl(`authtry:${ip}:${Math.floor(Date.now() / 3_600_000)}`, 3600);
    if (attempts > MAX_ATTEMPTS_PER_HOUR) {
      throw new HttpError(429, 'too_many_attempts', 'Too many sign-in attempts. Try again in an hour.');
    }

    const body = await readJsonBody(req, 8 * 1024);
    await verifyTurnstile(body.turnstile_token, ip);

    const result = await store.checkInvite(body.code);
    if (!result.ok) {
      // One message for every failure mode so a caller cannot distinguish "wrong code"
      // from "revoked code" and enumerate valid ones.
      throw new HttpError(403, 'invalid_invite', 'That invite code is not valid.');
    }

    return sendJson(
      res,
      200,
      { ok: true, durable_store: store.durable },
      { 'Set-Cookie': sessionCookie(issueSession(result.hash)) },
    );
  } catch (err) {
    return sendError(res, err);
  }
}
