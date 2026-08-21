/**
 * Archive hardening.
 *
 * Every case here corresponds to a way a crafted ZIP can escape extraction or exhaust the
 * machine unpacking it.
 */

import { describe, expect, it } from 'vitest';

import { ARCHIVE_LIMITS } from '../core/limits';
import {
  ArchiveRejected,
  auditArchive,
  detectRootPrefix,
  stripRootPrefix,
  type RawArchiveEntry,
} from '../transfer/archive';

const file = (name: string, extra: Partial<RawArchiveEntry> = {}): RawArchiveEntry => ({
  name,
  size: 100,
  compressedSize: 50,
  mode: 0o100644,
  isDirectory: false,
  ...extra,
});

const reasonFor = (entries: RawArchiveEntry[], name: string) =>
  auditArchive([file('package.json'), ...entries]).rejected.find((r) => r.name === name)?.reason;

describe('auditArchive', () => {
  it('accepts an ordinary project', () => {
    const audit = auditArchive([
      file('package.json'),
      file('app/page.tsx'),
      file('public/logo.svg'),
      { name: 'app/', size: 0, isDirectory: true, mode: 0o040755 },
    ]);
    expect(audit.accepted.map((a) => a.path)).toEqual(['package.json', 'app/page.tsx', 'public/logo.svg']);
    expect(audit.rejected).toHaveLength(0);
  });

  it('rejects path traversal and absolute paths', () => {
    expect(reasonFor([file('../../etc/passwd')], '../../etc/passwd')).toBe('invalid-path');
    expect(reasonFor([file('/etc/passwd')], '/etc/passwd')).toBe('invalid-path');
    expect(reasonFor([file('a/../../b.txt')], 'a/../../b.txt')).toBe('invalid-path');
  });

  it('rejects symlinks, which are the classic write-through escape', () => {
    expect(reasonFor([file('link', { mode: 0o120777 })], 'link')).toBe('symlink');
  });

  it('rejects device, socket, and FIFO entries', () => {
    expect(reasonFor([file('dev', { mode: 0o020666 })], 'dev')).toBe('special-file');
    expect(reasonFor([file('sock', { mode: 0o140666 })], 'sock')).toBe('special-file');
    expect(reasonFor([file('fifo', { mode: 0o010666 })], 'fifo')).toBe('special-file');
  });

  it('rejects an entry that expands far beyond its compressed size', () => {
    const bomb = file('bomb.txt', { size: 20 * 1024 * 1024, compressedSize: 1024 });
    expect(reasonFor([bomb], 'bomb.txt')).toBe('compression-ratio');
  });

  it('does not mistake a small well-compressed file for a bomb', () => {
    // 40 KB is below the ratio check's floor; real projects contain files like this.
    const audit = auditArchive([file('small.json', { size: 40 * 1024, compressedSize: 40 })]);
    expect(audit.rejected).toHaveLength(0);
  });

  it('rejects an entry larger than the per-file cap', () => {
    const huge = file('big.bin', {
      size: ARCHIVE_LIMITS.maxEntryBytes + 1,
      compressedSize: ARCHIVE_LIMITS.maxEntryBytes,
    });
    expect(reasonFor([huge], 'big.bin')).toBe('entry-too-large');
  });

  it('throws once the total uncompressed size exceeds the limit', () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      file(`big-${i}.bin`, { size: 20 * 1024 * 1024, compressedSize: 19 * 1024 * 1024 }),
    );
    expect(() => auditArchive(entries)).toThrow(ArchiveRejected);
  });

  it('throws once there are too many files', () => {
    const entries = Array.from({ length: ARCHIVE_LIMITS.maxFileCount + 10 }, (_, i) =>
      file(`src/f${i}.ts`, { size: 10, compressedSize: 10 }),
    );
    expect(() => auditArchive(entries)).toThrow(/more than/);
  });

  it('never imports credential files', () => {
    expect(reasonFor([file('.env')], '.env')).toBe('secret');
    expect(reasonFor([file('.env.production')], '.env.production')).toBe('secret');
    expect(reasonFor([file('deploy/id_rsa')], 'deploy/id_rsa')).toBe('secret');
    // The example file documents the variable names a deployment needs, so it stays.
    const audit = auditArchive([file('.env.example')]);
    expect(audit.accepted.map((a) => a.path)).toContain('.env.example');
  });

  it('skips dependency and build output', () => {
    expect(reasonFor([file('node_modules/react/index.js')], 'node_modules/react/index.js')).toBe('excluded');
    expect(reasonFor([file('.next/cache/x')], '.next/cache/x')).toBe('excluded');
    expect(reasonFor([file('.git/config')], '.git/config')).toBe('excluded');
  });

  it('rejects entries that collide when path case is ignored', () => {
    // On macOS and Windows these become one file and the second silently wins.
    const audit = auditArchive([file('src/App.tsx'), file('src/app.tsx')]);
    expect(audit.accepted).toHaveLength(1);
    expect(audit.rejected[0].reason).toBe('duplicate');
  });

  it('warns rather than failing on a large but legal archive', () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      file(`asset-${i}.bin`, { size: 10 * 1024 * 1024, compressedSize: 9 * 1024 * 1024 }),
    );
    const audit = auditArchive(entries);
    expect(audit.warnings.some((w) => w.includes('Vercel Drop'))).toBe(true);
    expect(audit.accepted).toHaveLength(6);
  });

  it('reports when credentials were dropped so the user is not surprised', () => {
    const audit = auditArchive([file('package.json'), file('.env')]);
    expect(audit.warnings.some((w) => w.includes('credential'))).toBe(true);
  });

  it('throws when nothing importable survives', () => {
    expect(() => auditArchive([file('node_modules/x.js')])).toThrow(/no importable files/);
  });
});

describe('root prefix handling', () => {
  it('detects a single wrapping directory', () => {
    expect(detectRootPrefix(['my-app/package.json', 'my-app/app/page.tsx'])).toBe('my-app');
  });

  it('does not strip when entries live at the root', () => {
    expect(detectRootPrefix(['package.json', 'my-app/page.tsx'])).toBeNull();
  });

  it('strips only the detected prefix', () => {
    expect(stripRootPrefix('my-app/package.json', 'my-app')).toBe('package.json');
    expect(stripRootPrefix('other/package.json', 'my-app')).toBe('other/package.json');
    expect(stripRootPrefix('package.json', null)).toBe('package.json');
  });
});
