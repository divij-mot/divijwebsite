/**
 * Content-addressed blob store on the Origin Private File System.
 *
 * Blobs are keyed by SHA-256 and sharded two levels deep, because a flat directory with
 * tens of thousands of entries makes OPFS directory enumeration crawl. A blob is
 * immutable, so "write" is a no-op when the hash already exists -- which is what makes a
 * checkpoint before every agent turn cost only the bytes that actually changed.
 *
 * Nothing here knows about projects or checkpoints. Reference tracking lives in
 * IndexedDB (storage/db.ts) and garbage collection is driven from storage/project.ts.
 */

import { hashBytes } from '../core/hash';

const ROOT_DIR = 'builder-blobs';

export interface BlobStore {
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array>;
  has(hash: string): Promise<boolean>;
  delete(hash: string): Promise<void>;
  listHashes(): Promise<string[]>;
  usage(): Promise<{ used: number; quota: number }>;
}

export function isOpfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined'
  );
}

function shardOf(hash: string): [string, string] {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`not a content hash: ${hash}`);
  return [hash.slice(0, 2), hash.slice(2, 4)];
}

class OpfsBlobStore implements BlobStore {
  private rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

  private root(): Promise<FileSystemDirectoryHandle> {
    this.rootPromise ??= navigator.storage
      .getDirectory()
      .then((dir) => dir.getDirectoryHandle(ROOT_DIR, { create: true }));
    return this.rootPromise;
  }

  private async shardDir(hash: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    const [a, b] = shardOf(hash);
    try {
      const root = await this.root();
      const first = await root.getDirectoryHandle(a, { create });
      return await first.getDirectoryHandle(b, { create });
    } catch (err) {
      if (!create && (err as DOMException)?.name === 'NotFoundError') return null;
      throw err;
    }
  }

  async put(bytes: Uint8Array): Promise<string> {
    const hash = await hashBytes(bytes);
    if (await this.has(hash)) return hash;

    const dir = await this.shardDir(hash, true);
    if (!dir) throw new Error('could not open blob shard');

    // Write to a temporary name and rename on completion. A tab closed mid-write would
    // otherwise leave a truncated blob under a hash that claims to describe full content.
    const tmpName = `${hash}.tmp-${Math.random().toString(36).slice(2)}`;
    const tmp = await dir.getFileHandle(tmpName, { create: true });
    const writable = await tmp.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (err) {
      await writable.abort().catch(() => {});
      await dir.removeEntry(tmpName).catch(() => {});
      throw err;
    }

    if (typeof (tmp as unknown as { move?: unknown }).move === 'function') {
      await (tmp as unknown as { move: (n: string) => Promise<void> }).move(hash);
    } else {
      // Safari lacks FileSystemFileHandle.move; copy through and drop the temp file.
      const final = await dir.getFileHandle(hash, { create: true });
      const w = await final.createWritable();
      await w.write(bytes);
      await w.close();
      await dir.removeEntry(tmpName).catch(() => {});
    }
    return hash;
  }

  async get(hash: string): Promise<Uint8Array> {
    const dir = await this.shardDir(hash, false);
    if (!dir) throw new Error(`blob ${hash} not found`);
    const handle = await dir.getFileHandle(hash).catch(() => null);
    if (!handle) throw new Error(`blob ${hash} not found`);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async has(hash: string): Promise<boolean> {
    const dir = await this.shardDir(hash, false);
    if (!dir) return false;
    return dir
      .getFileHandle(hash)
      .then(() => true)
      .catch(() => false);
  }

  async delete(hash: string): Promise<void> {
    const dir = await this.shardDir(hash, false);
    if (!dir) return;
    await dir.removeEntry(hash).catch(() => {});
  }

  async listHashes(): Promise<string[]> {
    const out: string[] = [];
    const root = await this.root();
    for await (const [, first] of iterate(root)) {
      if (first.kind !== 'directory') continue;
      for await (const [, second] of iterate(first as FileSystemDirectoryHandle)) {
        if (second.kind !== 'directory') continue;
        for await (const [name, entry] of iterate(second as FileSystemDirectoryHandle)) {
          if (entry.kind === 'file' && /^[0-9a-f]{64}$/.test(name)) out.push(name);
        }
      }
    }
    return out;
  }

  async usage(): Promise<{ used: number; quota: number }> {
    const est = await navigator.storage.estimate();
    return { used: est.usage ?? 0, quota: est.quota ?? 0 };
  }
}

type DirIterable = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

function iterate(dir: FileSystemDirectoryHandle): AsyncIterableIterator<[string, FileSystemHandle]> {
  return (dir as DirIterable).entries();
}

/**
 * Used by tests and by browsers without OPFS. Values are held for the page's lifetime
 * only, so the caller is responsible for warning that nothing is durable.
 */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<string> {
    const hash = await hashBytes(bytes);
    if (!this.blobs.has(hash)) this.blobs.set(hash, bytes.slice());
    return hash;
  }

  async get(hash: string): Promise<Uint8Array> {
    const found = this.blobs.get(hash);
    if (!found) throw new Error(`blob ${hash} not found`);
    return found.slice();
  }

  async has(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }

  async delete(hash: string): Promise<void> {
    this.blobs.delete(hash);
  }

  async listHashes(): Promise<string[]> {
    return [...this.blobs.keys()];
  }

  async usage(): Promise<{ used: number; quota: number }> {
    let used = 0;
    for (const b of this.blobs.values()) used += b.byteLength;
    return { used, quota: Number.POSITIVE_INFINITY };
  }
}

let singleton: BlobStore | null = null;

export function getBlobStore(): BlobStore {
  singleton ??= isOpfsAvailable() ? new OpfsBlobStore() : new MemoryBlobStore();
  return singleton;
}

/** Test seam. */
export function setBlobStore(store: BlobStore | null): void {
  singleton = store;
}
