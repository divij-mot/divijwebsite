/**
 * Local persistence: content addressing, checkpoint deduplication, restore, garbage
 * collection, secret refusal, and the multi-tab lock.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PROJECT_SCHEMA_VERSION } from '../core/limits';
import type { ProjectManifest } from '../core/types';
import { MemoryBlobStore, getBlobStore, setBlobStore } from '../storage/opfs';
import { ProjectStore } from '../storage/project';
import * as db from '../storage/db';

function manifest(name = 'test-app'): ProjectManifest {
  const now = Date.now();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name,
    createdAt: now,
    updatedAt: now,
    framework: 'nextjs',
    packageManager: 'npm',
    commands: { install: 'npm install', dev: 'npm run dev', build: 'npm run build' },
    port: 3000,
    requiredEnv: [],
    capabilities: { database: false, auth: false, storage: false, payments: false },
  };
}

beforeEach(async () => {
  // A fresh IndexedDB and blob store per test keeps them independent. Replacing the
  // global is how fake-indexeddb is meant to be reset.
  Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), configurable: true });
  db.resetDbForTests();
  setBlobStore(new MemoryBlobStore());
});

describe('content addressing', () => {
  it('stores identical bytes once', async () => {
    const store = getBlobStore();
    const bytes = new TextEncoder().encode('hello');
    const a = await store.put(bytes);
    const b = await store.put(new TextEncoder().encode('hello'));
    expect(a).toBe(b);
    expect(await store.listHashes()).toHaveLength(1);
  });

  it('round-trips binary content exactly', async () => {
    const store = getBlobStore();
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 0, 128]);
    const hash = await store.put(bytes);
    expect(Array.from(await store.get(hash))).toEqual(Array.from(bytes));
  });
});

describe('ProjectStore', () => {
  it('writes, reads, and reports no-op writes', async () => {
    const project = await ProjectStore.create(manifest());
    expect(await project.writeFile({ path: 'app/page.tsx', content: 'export default 1;' })).toBe(true);
    // The same bytes again should not count as a change, so callers can skip a sync.
    expect(await project.writeFile({ path: 'app/page.tsx', content: 'export default 1;' })).toBe(false);
    expect(await project.readText('app/page.tsx')).toBe('export default 1;');
    expect(project.listPaths()).toEqual(['app/page.tsx']);
  });

  it('refuses to store credential files', async () => {
    const project = await ProjectStore.create(manifest());
    await expect(project.writeFile({ path: '.env', content: 'SECRET=1' })).rejects.toThrow(/credential/i);
    await expect(project.writeFile({ path: 'config/.env.production', content: 'X=1' })).rejects.toThrow();
    // The example file is allowed: it carries names, not values.
    await expect(project.writeFile({ path: '.env.example', content: 'X=' })).resolves.toBe(true);
  });

  it('rejects traversal in a write path', async () => {
    const project = await ProjectStore.create(manifest());
    await expect(project.writeFile({ path: '../escape.txt', content: 'x' })).rejects.toThrow();
  });

  it('deduplicates blobs across checkpoints', async () => {
    const project = await ProjectStore.create(manifest());
    for (let i = 0; i < 50; i += 1) {
      await project.writeFile({ path: `src/f${i}.ts`, content: `export const n = ${i};` });
    }
    await project.createCheckpoint('pre-turn', 'first');

    // One file changes; the checkpoint should cost one new blob, not fifty.
    const before = (await getBlobStore().listHashes()).length;
    await project.writeFile({ path: 'src/f0.ts', content: 'export const n = 999;' });
    await project.createCheckpoint('post-turn', 'second');
    const after = (await getBlobStore().listHashes()).length;

    expect(after - before).toBe(1);
    expect((await project.listCheckpoints())).toHaveLength(2);
  });

  it('restores a checkpoint, removing files added afterwards', async () => {
    const project = await ProjectStore.create(manifest());
    await project.writeFile({ path: 'a.ts', content: 'original' });
    const checkpoint = await project.createCheckpoint('pre-turn', 'before edits');

    await project.writeFile({ path: 'a.ts', content: 'modified' });
    await project.writeFile({ path: 'b.ts', content: 'new file' });
    expect(project.listPaths()).toEqual(['a.ts', 'b.ts']);

    const result = await project.restoreCheckpoint(checkpoint.id);
    expect(result.restored).toBe(1);
    expect(result.removed).toBe(1);
    expect(project.listPaths()).toEqual(['a.ts']);
    expect(await project.readText('a.ts')).toBe('original');
  });

  it('refuses to restore a checkpoint whose blobs are missing', async () => {
    const project = await ProjectStore.create(manifest());
    await project.writeFile({ path: 'a.ts', content: 'original' });
    const checkpoint = await project.createCheckpoint('pre-turn', 'x');

    // Simulate an over-eager sweep having removed the blob.
    for (const hash of await getBlobStore().listHashes()) await getBlobStore().delete(hash);

    await expect(project.restoreCheckpoint(checkpoint.id)).rejects.toThrow(/incomplete/i);
  });

  it('collects blobs no checkpoint or current tree references', async () => {
    const project = await ProjectStore.create(manifest());
    await project.writeFile({ path: 'a.ts', content: 'v1' });
    await project.writeFile({ path: 'a.ts', content: 'v2' });
    await project.writeFile({ path: 'a.ts', content: 'v3' });
    expect(await getBlobStore().listHashes()).toHaveLength(3);

    const result = await project.collectGarbage();
    expect(result.deleted).toBe(2);
    expect(await getBlobStore().listHashes()).toHaveLength(1);
    expect(await project.readText('a.ts')).toBe('v3');
  });

  it('keeps blobs that a checkpoint still references', async () => {
    const project = await ProjectStore.create(manifest());
    await project.writeFile({ path: 'a.ts', content: 'v1' });
    await project.createCheckpoint('pre-turn', 'keeps v1');
    await project.writeFile({ path: 'a.ts', content: 'v2' });

    await project.collectGarbage();
    expect(await getBlobStore().listHashes()).toHaveLength(2);
  });

  it('excludes dependencies and secrets from the sandbox sync set', async () => {
    const project = await ProjectStore.create(manifest());
    await project.writeFile({ path: 'app/page.tsx', content: 'x' });
    await project.writeFile({ path: '.env.example', content: 'KEY=' });
    // Written directly to the tree to model a file that arrived before the rules existed.
    const bytes = new TextEncoder().encode('junk');
    const hash = await getBlobStore().put(bytes);
    project.files['node_modules/react/index.js'] = {
      path: 'node_modules/react/index.js',
      hash,
      size: bytes.length,
      binary: false,
      modifiedAt: Date.now(),
    };

    expect(project.syncableFiles().map((f) => f.path).sort()).toEqual(['.env.example', 'app/page.tsx']);
  });

  it('computes a minimal upload set against a sandbox listing', async () => {
    const project = await ProjectStore.create(manifest());
    await project.writeFile({ path: 'a.ts', content: 'same' });
    await project.writeFile({ path: 'b.ts', content: 'changed' });
    const remote = { 'a.ts': project.files['a.ts'].hash, 'stale.ts': 'deadbeef' };

    const diff = project.diffAgainst(remote);
    expect(diff.unchanged).toBe(1);
    expect(diff.upload.map((f) => f.path)).toEqual(['b.ts']);
    expect(diff.delete).toEqual(['stale.ts']);
  });

  it('persists chat and reloads it', async () => {
    const project = await ProjectStore.create(manifest());
    await project.appendMessage({ id: 'm1', role: 'user', content: 'hello', createdAt: Date.now() });
    await project.appendMessage({ id: 'm2', role: 'assistant', content: 'hi', createdAt: Date.now() });

    const reopened = await ProjectStore.open(project.projectId);
    expect(reopened.chat.map((m) => m.content)).toEqual(['hello', 'hi']);
  });

  it('trims chat to the checkpoint when restoring', async () => {
    const project = await ProjectStore.create(manifest());
    await project.appendMessage({ id: 'm1', role: 'user', content: 'first', createdAt: Date.now() });
    const checkpoint = await project.createCheckpoint('pre-turn', 'x');
    await project.appendMessage({ id: 'm2', role: 'assistant', content: 'later', createdAt: Date.now() });

    await project.restoreCheckpoint(checkpoint.id);
    expect(project.chat.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('multi-tab locking', () => {
  const stubLocks = () => {
    const rooms = new Map<string, Set<{ onmessage: ((event: { data: unknown }) => void) | null; postMessage: (data: unknown) => void; close: () => void }>>();
    class FakeChannel {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor(private readonly name: string) {
        if (!rooms.has(name)) rooms.set(name, new Set());
        rooms.get(name)!.add(this);
      }
      postMessage(data: unknown) {
        for (const peer of rooms.get(this.name) ?? []) {
          if (peer !== this) peer.onmessage?.({ data });
        }
      }
      close() {
        rooms.get(this.name)?.delete(this);
      }
    }
    vi.stubGlobal('BroadcastChannel', FakeChannel);

    let held = false;
    vi.stubGlobal('navigator', {
      locks: {
        request: (
          _name: string,
          _options: unknown,
          callback: (lock: unknown) => Promise<unknown>,
        ) => {
          void (async () => {
            if (held) {
              await callback(null);
              return;
            }
            held = true;
            try {
              await callback({ name: _name });
            } finally {
              held = false;
            }
          })();
        },
      },
    });
  };

  it('gives the second tab read-only access rather than racing', async () => {
    stubLocks();

    const { acquireProjectLock } = await import('../storage/lock');
    const first = await acquireProjectLock('p1');
    expect(first.state).toBe('writer');

    const second = await acquireProjectLock('p1');
    expect(second.state).toBe('reader');

    first.release();
    vi.unstubAllGlobals();
  });

  it('lets a tab take control from another tab', async () => {
    stubLocks();

    const { acquireProjectLock } = await import('../storage/lock');
    const first = await acquireProjectLock('p-steal');
    expect(first.state).toBe('writer');

    const stolen = first.stolen.then(() => 'stolen');
    const second = await acquireProjectLock('p-steal', { steal: true });
    expect(second.state).toBe('writer');
    expect(first.state).toBe('reader');
    expect(await stolen).toBe('stolen');

    second.release();
    vi.unstubAllGlobals();
  });

  it('reports unsupported when the browser has no Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    const { acquireProjectLock } = await import('../storage/lock');
    expect((await acquireProjectLock('p2')).state).toBe('unsupported');
    vi.unstubAllGlobals();
  });
});

describe('provider settings', () => {
  it('never persists an API key, even if one is passed in', async () => {
    await db.saveProviderSettings({
      presetId: 'openai',
      model: 'gpt-5.1',
      protocol: 'openai-responses',
      transport: 'relay',
      // A caller mistakenly including a key must not be able to persist it.
      apiKey: 'sk-should-never-be-stored',
    } as never);

    const loaded = await db.loadProviderSettings();
    expect(loaded?.model).toBe('gpt-5.1');
    expect(JSON.stringify(loaded)).not.toContain('sk-should-never-be-stored');
    expect((loaded as { apiKey?: string })?.apiKey).toBeUndefined();
  });
});
