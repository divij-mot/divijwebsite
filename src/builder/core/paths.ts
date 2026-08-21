/**
 * Path containment.
 *
 * Every path that crosses a boundary -- an uploaded archive entry, a model-authored file
 * write, a directory import, a name shown in the editor -- passes through
 * `normalizeProjectPath`. It is the single place that decides whether a string is a legal
 * project-relative path, so there is one thing to audit rather than a dozen ad-hoc checks.
 *
 * Rejection is by allowlist of shape, not by blocklist of known-bad strings, because the
 * blocklist approach loses to encoding tricks. See __tests__/paths.test.ts for the corpus.
 */

import { ARCHIVE_LIMITS, EXCLUDED_DIRECTORIES, SECRET_FILE_PATTERNS } from './limits';

export class PathRejected extends Error {
  constructor(
    public readonly input: string,
    public readonly reason: string,
  ) {
    super(`Rejected path ${JSON.stringify(input)}: ${reason}`);
    this.name = 'PathRejected';
  }
}

/** Windows reserved device names, which are still special when they carry an extension. */
const WINDOWS_DEVICES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Normalize an untrusted path to a project-relative POSIX path, or throw.
 *
 * Guarantees on the returned value: no leading slash, no drive letter, no "." or ".."
 * segment, no backslash, no NUL or control characters, no empty segment, and a bounded
 * length and depth.
 */
export function normalizeProjectPath(input: string): string {
  if (typeof input !== 'string') throw new PathRejected(String(input), 'not a string');
  if (input.length === 0) throw new PathRejected(input, 'empty');
  if (input.length > ARCHIVE_LIMITS.maxPathLength) {
    throw new PathRejected(input, `longer than ${ARCHIVE_LIMITS.maxPathLength} characters`);
  }

  // Control characters and NUL truncate paths in C-based filesystem layers.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new PathRejected(input, 'control character');

  // Percent-encoding is not meaningful in a filesystem path, and decoding it here would
  // let "%2e%2e%2f" reintroduce traversal after the check.
  if (/%2e/i.test(input) || /%2f/i.test(input) || /%5c/i.test(input)) {
    throw new PathRejected(input, 'percent-encoded path separator or dot');
  }

  // Unicode normalization first, so a decomposed ".." cannot slip past the segment check.
  let p = input.normalize('NFC');

  if (p.includes('\\')) throw new PathRejected(input, 'backslash separator');
  if (/^[a-zA-Z]:/.test(p)) throw new PathRejected(input, 'drive letter');
  if (p.startsWith('/')) throw new PathRejected(input, 'absolute path');
  if (p.startsWith('~')) throw new PathRejected(input, 'home-relative path');

  // Some archive tools emit "./" prefixes; those are safe to drop, unlike "..".
  while (p.startsWith('./')) p = p.slice(2);

  const segments = p.split('/');
  if (segments.length > ARCHIVE_LIMITS.maxPathDepth) {
    throw new PathRejected(input, `deeper than ${ARCHIVE_LIMITS.maxPathDepth} segments`);
  }

  const clean: string[] = [];
  for (const seg of segments) {
    if (seg === '' ) {
      // A trailing slash is a directory marker the caller strips; an interior empty
      // segment ("a//b") is malformed.
      if (seg === segments[segments.length - 1]) continue;
      throw new PathRejected(input, 'empty path segment');
    }
    if (seg === '.') continue;
    if (seg === '..') throw new PathRejected(input, 'parent traversal');
    if (seg.endsWith('.') || seg.endsWith(' ')) {
      // Windows silently strips these, so "a.txt." and "a.txt" can collide.
      throw new PathRejected(input, 'segment ends with a dot or space');
    }
    if (WINDOWS_DEVICES.test(seg)) throw new PathRejected(input, 'reserved device name');
    clean.push(seg);
  }

  if (clean.length === 0) throw new PathRejected(input, 'resolves to the project root');
  return clean.join('/');
}

/** Non-throwing form for filtering large listings. */
export function tryNormalizeProjectPath(input: string): string | null {
  try {
    return normalizeProjectPath(input);
  } catch {
    return null;
  }
}

/**
 * Join a project-relative path onto the guest workspace root.
 * Re-validates rather than trusting the caller, since this produces an absolute path
 * that goes straight to the sandbox filesystem API.
 */
export function toWorkspacePath(root: string, projectPath: string): string {
  const rel = normalizeProjectPath(projectPath);
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  const joined = `${base}/${rel}`;
  // Defence in depth: the result must still be inside the root after string assembly.
  if (!joined.startsWith(`${base}/`) || joined.includes('/../')) {
    throw new PathRejected(projectPath, 'escapes the workspace root');
  }
  return joined;
}

/** Convert an absolute guest path back to a project-relative one, or null if outside. */
export function fromWorkspacePath(root: string, absolute: string): string | null {
  const base = root.endsWith('/') ? root : `${root}/`;
  if (!absolute.startsWith(base)) return null;
  return tryNormalizeProjectPath(absolute.slice(base.length));
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

/** True when any segment is a build artifact, dependency tree, or VCS directory. */
export function isExcludedPath(path: string): boolean {
  return path.split('/').some((seg) => EXCLUDED_DIRECTORIES.includes(seg));
}

/**
 * True when the path looks like it holds credentials.
 *
 * Applied on import (never store it), on export (never ship it), and on sandbox sync
 * (never upload it). `.env.example` is deliberately allowed through -- it documents the
 * variable names the deployment needs, which is the whole portability contract.
 */
export function isSecretPath(path: string): boolean {
  const segments = path.split('/');
  return segments.some((seg) => SECRET_FILE_PATTERNS.some((re) => re.test(seg)));
}

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.mdx', '.css',
  '.scss', '.sass', '.less', '.html', '.htm', '.xml', '.svg', '.txt', '.yml', '.yaml',
  '.toml', '.ini', '.env', '.example', '.sh', '.bash', '.zsh', '.sql', '.graphql', '.gql',
  '.prisma', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.vue',
  '.svelte', '.astro', '.lock', '.gitignore', '.npmrc', '.editorconfig', '.prettierrc',
]);

const TEXT_BASENAMES = new Set([
  'Dockerfile', 'Makefile', 'LICENSE', 'README', 'CHANGELOG', '.gitignore', '.gitattributes',
  '.dockerignore', '.vercelignore', '.editorconfig', '.nvmrc', '.node-version', '.npmrc',
  '.prettierrc', '.eslintrc', 'Procfile',
]);

/** Extension-based guess, used before bytes are available. */
export function looksTextual(path: string): boolean {
  const base = basename(path);
  if (TEXT_BASENAMES.has(base)) return true;
  const ext = extname(path);
  if (ext) return TEXT_EXTENSIONS.has(ext);
  // Extensionless dotfiles are configuration far more often than binaries.
  return base.startsWith('.');
}

/**
 * Byte-level check, which beats the extension guess when they disagree.
 * A NUL in the first 8 KB, or a high proportion of undecodable bytes, means binary.
 */
export function isBinaryContent(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 8192);
  for (let i = 0; i < window.length; i += 1) {
    if (window[i] === 0) return true;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(window);
    return false;
  } catch {
    return true;
  }
}
