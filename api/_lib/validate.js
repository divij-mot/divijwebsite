/**
 * Server-side path containment.
 *
 * This repeats the checks in src/builder/core/paths.ts on purpose. The browser copy gives
 * users fast feedback; this copy is the one that actually protects the sandbox, because a
 * request can be crafted by anything, not just our UI.
 *
 * Keep the two in step: src/builder/__tests__/paths.test.ts runs the same rejection corpus
 * against both implementations.
 */

import { ARCHIVE_LIMITS, WORKSPACE_ROOT } from './limits.js';
import { HttpError } from './session.js';

const WINDOWS_DEVICES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

const SECRET_PATTERNS = [
  /^\.env$/i,
  /^\.env\.(?!example$|sample$|template$)[\w.-]+$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^credentials\.json$/i,
  /^service-account.*\.json$/i,
];

/**
 * Normalize an untrusted project-relative path, or throw a 400.
 *
 * Returns a path guaranteed to have no leading slash, no traversal, no backslashes, no
 * control characters, and bounded length and depth.
 */
export function assertProjectPath(input) {
  const reject = (reason) =>
    new HttpError(400, 'invalid_path', `Rejected path ${JSON.stringify(String(input))}: ${reason}`);

  if (typeof input !== 'string' || input.length === 0) throw reject('empty or not a string');
  if (input.length > ARCHIVE_LIMITS.maxPathLength) throw reject('too long');
  if (/[\u0000-\u001f\u007f]/.test(input)) throw reject('control character');
  if (/%2e/i.test(input) || /%2f/i.test(input) || /%5c/i.test(input)) {
    throw reject('percent-encoded separator or dot');
  }

  let p = input.normalize('NFC');
  if (p.includes('\\')) throw reject('backslash separator');
  if (/^[a-zA-Z]:/.test(p)) throw reject('drive letter');
  if (p.startsWith('/')) throw reject('absolute path');
  if (p.startsWith('~')) throw reject('home-relative path');
  while (p.startsWith('./')) p = p.slice(2);

  const segments = p.split('/');
  if (segments.length > ARCHIVE_LIMITS.maxPathDepth) throw reject('too deep');

  const clean = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg === '') {
      if (i === segments.length - 1) continue;
      throw reject('empty path segment');
    }
    if (seg === '.') continue;
    if (seg === '..') throw reject('parent traversal');
    if (seg.endsWith('.') || seg.endsWith(' ')) throw reject('segment ends with a dot or space');
    if (WINDOWS_DEVICES.test(seg)) throw reject('reserved device name');
    clean.push(seg);
  }
  if (clean.length === 0) throw reject('resolves to the project root');

  const result = clean.join('/');
  if (isSecretPath(result)) {
    throw new HttpError(
      400,
      'secret_path_rejected',
      `${result} looks like a credential file. Those are never written to the sandbox; use an environment variable.`,
    );
  }
  return result;
}

export function isSecretPath(path) {
  return path.split('/').some((seg) => SECRET_PATTERNS.some((re) => re.test(seg)));
}

/**
 * Turn a validated project path into an absolute guest path.
 * Re-checks containment after assembly so a bug above cannot produce an escape here.
 */
export function toGuestPath(relative) {
  const joined = `${WORKSPACE_ROOT}/${relative}`;
  if (!joined.startsWith(`${WORKSPACE_ROOT}/`) || joined.includes('/../')) {
    throw new HttpError(400, 'invalid_path', 'Path escapes the workspace root.');
  }
  return joined;
}

/**
 * Validate a hostname the user wants added to the egress allowlist.
 *
 * Only public DNS names. IP literals are refused outright: the allowlist is matched on
 * name, and an IP entry would let someone name a private address directly. The proxy
 * independently re-resolves and range-checks at connection time, so this is the first of
 * two gates rather than the only one.
 */
export function assertPublicHostname(input) {
  const reject = (reason) => new HttpError(400, 'invalid_hostname', reason);

  if (typeof input !== 'string' || !input) throw reject('A hostname is required.');
  const host = input.trim().toLowerCase().replace(/\.$/, '');
  if (host.length > 253) throw reject('Hostname is too long.');
  if (host.includes('/') || host.includes(':') || host.includes('@')) {
    throw reject('Enter a bare hostname such as api.example.com, not a URL.');
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
    throw reject('That is not a valid hostname.');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    throw reject('IP addresses cannot be allowlisted. Use a hostname.');
  }
  if (/\.(local|internal|localhost|test|invalid|localdomain)$/.test(host) || host === 'localhost') {
    throw reject('Internal and reserved names cannot be allowlisted.');
  }
  if (/(^|\.)(metadata|instance-data)(\.|$)/.test(host)) {
    throw reject('Cloud metadata endpoints cannot be allowlisted.');
  }
  return host;
}

/** Bound arbitrary user-supplied strings before they reach a shell or a log line. */
export function assertShortString(value, field, max = 200) {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_args', `${field} must be a string.`);
  if (value.length > max) throw new HttpError(400, 'invalid_args', `${field} is too long.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new HttpError(400, 'invalid_args', `${field} contains control characters.`);
  }
  return value;
}
