/**
 * IndexedDB: everything about a project except file bytes.
 *
 * Manifests, checkpoints, chat, and provider settings live here; blobs live in OPFS
 * (storage/opfs.ts). The split matters because manifests are small and queried
 * constantly while blobs are large and read rarely.
 *
 * What is deliberately absent: API keys, hidden reasoning, raw provider payloads,
 * screenshots, and full terminal output. Those exist only in the worker's memory for the
 * lifetime of the tab. See PLAN "Local-only persistence".
 */

import type {
  ChatMessage,
  Checkpoint,
  ProjectManifest,
  ProjectSummary,
  ProviderSettings,
  TreeManifest,
} from '../core/types';

const DB_NAME = 'divij-builder';
const DB_VERSION = 1;

const STORES = {
  projects: 'projects',
  trees: 'trees',
  checkpoints: 'checkpoints',
  messages: 'messages',
  settings: 'settings',
} as const;

export interface ProjectRecord {
  id: string;
  manifest: ProjectManifest;
  createdAt: number;
  updatedAt: number;
}

interface MessageRecord extends ChatMessage {
  projectId: string;
  /** Position in the conversation; used to restore ordering and to anchor checkpoints. */
  seq: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.projects)) {
        db.createObjectStore(STORES.projects, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.trees)) {
        db.createObjectStore(STORES.trees, { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains(STORES.checkpoints)) {
        const s = db.createObjectStore(STORES.checkpoints, { keyPath: 'id' });
        s.createIndex('byProject', 'projectId');
      }
      if (!db.objectStoreNames.contains(STORES.messages)) {
        const s = db.createObjectStore(STORES.messages, { keyPath: 'id' });
        s.createIndex('byProject', 'projectId');
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = fn(tx.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

function queryIndex<T>(storeName: string, indexName: string, key: IDBValidKey): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).index(indexName).getAll(key);
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error);
      }),
  );
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function putProject(record: ProjectRecord): Promise<void> {
  await run(STORES.projects, 'readwrite', (s) => s.put(record));
}

export async function getProject(id: string): Promise<ProjectRecord | undefined> {
  return run<ProjectRecord | undefined>(STORES.projects, 'readonly', (s) => s.get(id));
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const records = await run<ProjectRecord[]>(STORES.projects, 'readonly', (s) => s.getAll());
  const trees = await run<TreeManifest[]>(STORES.trees, 'readonly', (s) => s.getAll());
  const byId = new Map(trees.map((t) => [t.projectId, t]));
  return records
    .map((r) => {
      const files = Object.values(byId.get(r.id)?.files ?? {});
      return {
        id: r.id,
        name: r.manifest.name,
        framework: r.manifest.framework,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        fileCount: files.length,
        totalBytes: files.reduce((n, f) => n + f.size, 0),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [STORES.projects, STORES.trees, STORES.checkpoints, STORES.messages],
      'readwrite',
    );
    tx.objectStore(STORES.projects).delete(id);
    tx.objectStore(STORES.trees).delete(id);
    for (const store of [STORES.checkpoints, STORES.messages] as const) {
      const idx = tx.objectStore(store).index('byProject');
      const cursorReq = idx.openCursor(IDBKeyRange.only(id));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Trees and checkpoints
// ---------------------------------------------------------------------------

export async function putTree(tree: TreeManifest): Promise<void> {
  await run(STORES.trees, 'readwrite', (s) => s.put(tree));
}

export async function getTree(projectId: string): Promise<TreeManifest | undefined> {
  return run<TreeManifest | undefined>(STORES.trees, 'readonly', (s) => s.get(projectId));
}

export async function putCheckpoint(checkpoint: Checkpoint): Promise<void> {
  await run(STORES.checkpoints, 'readwrite', (s) => s.put(checkpoint));
}

export async function listCheckpoints(projectId: string): Promise<Checkpoint[]> {
  const all = await queryIndex<Checkpoint>(STORES.checkpoints, 'byProject', projectId);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getCheckpoint(id: string): Promise<Checkpoint | undefined> {
  return run<Checkpoint | undefined>(STORES.checkpoints, 'readonly', (s) => s.get(id));
}

export async function deleteCheckpoint(id: string): Promise<void> {
  await run(STORES.checkpoints, 'readwrite', (s) => s.delete(id));
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function appendMessage(projectId: string, message: ChatMessage, seq: number): Promise<void> {
  await run(STORES.messages, 'readwrite', (s) => s.put({ ...message, projectId, seq }));
}

export async function updateMessage(projectId: string, message: ChatMessage, seq: number): Promise<void> {
  await appendMessage(projectId, message, seq);
}

/** Drops the storage-only fields so callers get a clean ChatMessage. */
function stripRecordFields(row: MessageRecord): ChatMessage {
  const copy: Partial<MessageRecord> = { ...row };
  delete copy.projectId;
  delete copy.seq;
  return copy as ChatMessage;
}

export async function listMessages(projectId: string): Promise<ChatMessage[]> {
  const rows = await queryIndex<MessageRecord>(STORES.messages, 'byProject', projectId);
  return rows.sort((a, b) => a.seq - b.seq).map(stripRecordFields);
}

export async function clearMessages(projectId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.messages, 'readwrite');
    const cursorReq = tx.objectStore(STORES.messages).index('byProject').openCursor(IDBKeyRange.only(projectId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface SettingRecord<T> {
  key: string;
  value: T;
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const rec = await run<SettingRecord<T> | undefined>(STORES.settings, 'readonly', (s) => s.get(key));
  return rec?.value;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await run(STORES.settings, 'readwrite', (s) => s.put({ key, value }));
}

const PROVIDER_SETTINGS_KEY = 'provider-settings';

/**
 * Provider preferences persist; the key does not. `loadProviderSettings` strips any
 * `apiKey` field defensively in case an older build ever wrote one.
 */
export async function loadProviderSettings(): Promise<ProviderSettings | undefined> {
  const stored = await getSetting<ProviderSettings & { apiKey?: string }>(PROVIDER_SETTINGS_KEY);
  if (!stored) return undefined;
  const safe: Partial<ProviderSettings & { apiKey?: string }> = { ...stored };
  delete safe.apiKey;
  return safe as ProviderSettings;
}

export async function saveProviderSettings(settings: ProviderSettings): Promise<void> {
  const { ...safe } = settings as ProviderSettings & { apiKey?: string };
  delete (safe as { apiKey?: string }).apiKey;
  await setSetting(PROVIDER_SETTINGS_KEY, safe);
}

/** Test seam: drop the cached connection so a fresh fake-indexeddb is picked up. */
export function resetDbForTests(): void {
  dbPromise = null;
}
