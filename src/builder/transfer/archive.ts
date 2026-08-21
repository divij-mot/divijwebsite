/**
 * Archive validation.
 *
 * An uploaded ZIP is the most hostile input the builder accepts, so every entry is judged
 * before a single byte is written. The checks here are the browser half of the
 * defence; api/_lib/validate.js repeats them server-side before anything reaches Mosaic,
 * because a validated-in-the-browser guarantee is worth nothing to the control plane.
 *
 * Rejected: absolute paths, traversal, symlinks, device and special files, entries larger
 * than the per-entry cap, archives over the total size or file-count cap, and entries
 * whose compression ratio marks them as a zip bomb.
 */

import { ARCHIVE_LIMITS } from '../core/limits';
import { isExcludedPath, isSecretPath, normalizeProjectPath, PathRejected } from '../core/paths';

export interface RawArchiveEntry {
  name: string;
  /** Uncompressed size, from the central directory when available. */
  size: number;
  compressedSize?: number;
  /** Unix mode from the external attributes, when the archive carries them. */
  mode?: number;
  isDirectory: boolean;
}

export type RejectionReason =
  | 'invalid-path'
  | 'symlink'
  | 'special-file'
  | 'entry-too-large'
  | 'compression-ratio'
  | 'excluded'
  | 'secret'
  | 'duplicate';

export interface RejectedEntry {
  name: string;
  reason: RejectionReason;
  detail: string;
}

export interface ArchiveAudit {
  accepted: { name: string; path: string; size: number }[];
  rejected: RejectedEntry[];
  warnings: string[];
  totalBytes: number;
  fileCount: number;
}

export class ArchiveRejected extends Error {
  constructor(
    message: string,
    public readonly audit?: Partial<ArchiveAudit>,
  ) {
    super(message);
    this.name = 'ArchiveRejected';
  }
}

/** POSIX file type bits from the ZIP external attributes high word. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function classifyMode(mode: number | undefined): 'regular' | 'symlink' | 'directory' | 'special' | 'unknown' {
  if (mode === undefined || mode === 0) return 'unknown';
  switch (mode & S_IFMT) {
    case S_IFLNK:
      return 'symlink';
    case S_IFREG:
      return 'regular';
    case S_IFDIR:
      return 'directory';
    default:
      return 'special';
  }
}

/**
 * Decide, entry by entry, what may be extracted.
 *
 * Throws only for whole-archive violations (too big, too many files). Individual bad
 * entries are recorded as rejections so the user sees exactly what was dropped and why,
 * rather than a single opaque failure for an otherwise usable archive.
 */
export function auditArchive(entries: RawArchiveEntry[]): ArchiveAudit {
  const audit: ArchiveAudit = {
    accepted: [],
    rejected: [],
    warnings: [],
    totalBytes: 0,
    fileCount: 0,
  };

  const seen = new Map<string, string>();

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const kind = classifyMode(entry.mode);
    if (kind === 'symlink') {
      // A symlink is the classic escape: extract "link -> /etc/passwd", then write through it.
      audit.rejected.push({ name: entry.name, reason: 'symlink', detail: 'symbolic links are not extracted' });
      continue;
    }
    if (kind === 'special') {
      audit.rejected.push({
        name: entry.name,
        reason: 'special-file',
        detail: 'device, socket, or FIFO entries are not extracted',
      });
      continue;
    }

    let path: string;
    try {
      path = normalizeProjectPath(entry.name);
    } catch (err) {
      audit.rejected.push({
        name: entry.name,
        reason: 'invalid-path',
        detail: err instanceof PathRejected ? err.reason : String(err),
      });
      continue;
    }

    if (entry.size > ARCHIVE_LIMITS.maxEntryBytes) {
      audit.rejected.push({
        name: entry.name,
        reason: 'entry-too-large',
        detail: `${formatBytes(entry.size)} exceeds the ${formatBytes(ARCHIVE_LIMITS.maxEntryBytes)} per-file limit`,
      });
      continue;
    }

    // Ratio is only meaningful once an entry is big enough that compression could have
    // done real work; a 12-byte file that compresses to 2 bytes is not an attack.
    if (entry.compressedSize !== undefined && entry.compressedSize > 0 && entry.size > 64 * 1024) {
      const ratio = entry.size / entry.compressedSize;
      if (ratio > ARCHIVE_LIMITS.maxCompressionRatio) {
        audit.rejected.push({
          name: entry.name,
          reason: 'compression-ratio',
          detail: `expands ${Math.round(ratio)}x, above the ${ARCHIVE_LIMITS.maxCompressionRatio}x limit`,
        });
        continue;
      }
    }

    if (isSecretPath(path)) {
      audit.rejected.push({
        name: entry.name,
        reason: 'secret',
        detail: 'credential files are never imported',
      });
      continue;
    }

    if (isExcludedPath(path)) {
      audit.rejected.push({
        name: entry.name,
        reason: 'excluded',
        detail: 'dependency or build output, regenerated in the sandbox',
      });
      continue;
    }

    // Case-insensitive collision: two entries that differ only in case become one file on
    // macOS and Windows, and the second silently overwrites the first.
    const key = path.toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined) {
      audit.rejected.push({
        name: entry.name,
        reason: 'duplicate',
        detail: `collides with ${prior} when path case is ignored`,
      });
      continue;
    }
    seen.set(key, path);

    audit.accepted.push({ name: entry.name, path, size: entry.size });
    audit.totalBytes += entry.size;
    audit.fileCount += 1;

    if (audit.fileCount > ARCHIVE_LIMITS.maxFileCount) {
      throw new ArchiveRejected(
        `Archive contains more than ${ARCHIVE_LIMITS.maxFileCount.toLocaleString()} files.`,
        audit,
      );
    }
    if (audit.totalBytes > ARCHIVE_LIMITS.maxUncompressedBytes) {
      throw new ArchiveRejected(
        `Archive expands to more than ${formatBytes(ARCHIVE_LIMITS.maxUncompressedBytes)}.`,
        audit,
      );
    }
  }

  if (audit.fileCount === 0) {
    throw new ArchiveRejected('Archive contains no importable files.', audit);
  }
  if (audit.totalBytes > ARCHIVE_LIMITS.warnUncompressedBytes) {
    audit.warnings.push(
      `Project is ${formatBytes(audit.totalBytes)}. Vercel Drop uploads get noticeably slower above ${formatBytes(ARCHIVE_LIMITS.warnUncompressedBytes)}.`,
    );
  }

  const secretsDropped = audit.rejected.filter((r) => r.reason === 'secret').length;
  if (secretsDropped) {
    audit.warnings.push(
      `Skipped ${secretsDropped} credential file(s). Re-enter those values as environment variables; they are never stored.`,
    );
  }

  return audit;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Many archives wrap the project in a single top-level directory ("my-app/package.json").
 * Returns that prefix when every entry shares it, so imports land at the project root.
 */
export function detectRootPrefix(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const first = paths[0].split('/')[0];
  if (!first) return null;

  // Never strip "." or "..". An archive of "../../etc/passwd" shares the prefix ".." with
  // every sibling, and removing one level would turn a path the auditor rejects outright
  // into one that merely looks unusual -- partially undoing the escape we are guarding
  // against. Traversal is the auditor's job, and it must see the path intact.
  if (first === '.' || first === '..') return null;

  if (paths.some((p) => !p.startsWith(`${first}/`))) return null;
  return first;
}

export function stripRootPrefix(path: string, prefix: string | null): string {
  return prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
}
