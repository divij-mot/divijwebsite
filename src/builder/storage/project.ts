/**
 * The durable truth for a project.
 *
 * PLAN: "Treat the local source tree as durable truth and Mosaic as a synchronized
 * working copy." Everything the user can lose lives here -- source, chat, checkpoints --
 * and the sandbox is rebuilt from it whenever it disappears.
 *
 * Composition: file bytes in the OPFS blob store, manifests/checkpoints/chat in
 * IndexedDB, and a Web Lock making this tab the only writer.
 */

import { hashBytes, randomId } from '../core/hash';
import { isExcludedPath, isSecretPath, normalizeProjectPath } from '../core/paths';
import type {
  ChatMessage,
  Checkpoint,
  FileEntry,
  ProjectManifest,
  TreeManifest,
} from '../core/types';
import * as db from './db';
import { acquireProjectLock, type AcquireLockOptions, type ProjectLock } from './lock';
import { getBlobStore } from './opfs';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class ReadOnlyProjectError extends Error {
  constructor() {
    super('This project is open in another tab. Close it there to make changes here.');
    this.name = 'ReadOnlyProjectError';
  }
}

export interface WriteFileInput {
  path: string;
  content: string | Uint8Array;
}

export class ProjectStore {
  private tree: TreeManifest;
  private messages: ChatMessage[] = [];

  private constructor(
    public readonly projectId: string,
    private manifestValue: ProjectManifest,
    tree: TreeManifest,
    private readonly lock: ProjectLock,
  ) {
    this.tree = tree;
  }

  static async open(projectId: string, options: AcquireLockOptions = {}): Promise<ProjectStore> {
    const lock = await acquireProjectLock(projectId, options);
    const record = await db.getProject(projectId);
    if (!record) throw new Error(`project ${projectId} not found`);
    const tree = (await db.getTree(projectId)) ?? {
      projectId,
      files: {},
      updatedAt: Date.now(),
    };
    const store = new ProjectStore(projectId, record.manifest, tree, lock);
    store.messages = await db.listMessages(projectId);
    return store;
  }

  static async create(manifest: ProjectManifest): Promise<ProjectStore> {
    const projectId = randomId('proj');
    const now = Date.now();
    await db.putProject({ id: projectId, manifest, createdAt: now, updatedAt: now });
    const tree: TreeManifest = { projectId, files: {}, updatedAt: now };
    await db.putTree(tree);
    const lock = await acquireProjectLock(projectId);
    return new ProjectStore(projectId, manifest, tree, lock);
  }

  get readOnly(): boolean {
    return this.lock.state === 'reader';
  }

  /** Resolves when another tab takes the writer lock from this one. */
  get lockStolen(): Promise<void> {
    return this.lock.stolen;
  }

  get manifest(): ProjectManifest {
    return this.manifestValue;
  }

  get files(): Record<string, FileEntry> {
    return this.tree.files;
  }

  get chat(): readonly ChatMessage[] {
    return this.messages;
  }

  private assertWritable(): void {
    if (this.readOnly) throw new ReadOnlyProjectError();
  }

  close(): void {
    this.lock.release();
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  listPaths(): string[] {
    return Object.keys(this.tree.files).sort();
  }

  has(path: string): boolean {
    return normalizeProjectPath(path) in this.tree.files;
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const entry = this.tree.files[normalizeProjectPath(path)];
    if (!entry) throw new Error(`no such file: ${path}`);
    return getBlobStore().get(entry.hash);
  }

  async readText(path: string): Promise<string> {
    return decoder.decode(await this.readBytes(path));
  }

  /**
   * Write one file. Returns false when the content is byte-identical to what is already
   * there, which lets callers skip a sandbox sync and a checkpoint they do not need.
   */
  async writeFile(input: WriteFileInput): Promise<boolean> {
    this.assertWritable();
    const path = normalizeProjectPath(input.path);
    if (isSecretPath(path)) {
      throw new Error(
        `Refusing to store ${path}: credential files are never written to local storage or exports.`,
      );
    }
    const bytes = typeof input.content === 'string' ? encoder.encode(input.content) : input.content;
    const hash = await hashBytes(bytes);
    if (this.tree.files[path]?.hash === hash) return false;

    await getBlobStore().put(bytes);
    this.tree.files[path] = {
      path,
      hash,
      size: bytes.byteLength,
      binary: typeof input.content !== 'string',
      modifiedAt: Date.now(),
    };
    await this.persistTree();
    return true;
  }

  async writeFiles(inputs: WriteFileInput[]): Promise<string[]> {
    this.assertWritable();
    const changed: string[] = [];
    for (const input of inputs) {
      if (await this.writeFile(input)) changed.push(normalizeProjectPath(input.path));
    }
    return changed;
  }

  async deleteFile(path: string): Promise<boolean> {
    this.assertWritable();
    const p = normalizeProjectPath(path);
    if (!(p in this.tree.files)) return false;
    delete this.tree.files[p];
    await this.persistTree();
    return true;
  }

  /** Deletes every file under a directory prefix. Returns the paths removed. */
  async deleteDirectory(prefix: string): Promise<string[]> {
    this.assertWritable();
    const p = normalizeProjectPath(prefix);
    const removed = Object.keys(this.tree.files).filter((f) => f === p || f.startsWith(`${p}/`));
    for (const f of removed) delete this.tree.files[f];
    if (removed.length) await this.persistTree();
    return removed;
  }

  async moveFile(from: string, to: string): Promise<void> {
    this.assertWritable();
    const src = normalizeProjectPath(from);
    const dst = normalizeProjectPath(to);
    const entry = this.tree.files[src];
    if (!entry) throw new Error(`no such file: ${from}`);
    delete this.tree.files[src];
    this.tree.files[dst] = { ...entry, path: dst, modifiedAt: Date.now() };
    await this.persistTree();
  }

  private async persistTree(): Promise<void> {
    this.tree.updatedAt = Date.now();
    await db.putTree(this.tree);
    await db.putProject({
      id: this.projectId,
      manifest: this.manifestValue,
      createdAt: (await db.getProject(this.projectId))?.createdAt ?? Date.now(),
      updatedAt: this.tree.updatedAt,
    });
  }

  async updateManifest(patch: Partial<ProjectManifest>): Promise<void> {
    this.assertWritable();
    this.manifestValue = { ...this.manifestValue, ...patch, updatedAt: Date.now() };
    await this.persistTree();
  }

  // -------------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------------

  /**
   * Snapshot the current tree.
   *
   * Only the manifest is copied. Blobs are already content-addressed, so a checkpoint of
   * a 2,000-file project where one file changed writes one new blob and one small record.
   */
  async createCheckpoint(
    reason: Checkpoint['reason'],
    label: string,
    messageIndex = this.messages.length,
  ): Promise<Checkpoint> {
    this.assertWritable();
    const files = { ...this.tree.files };
    const checkpoint: Checkpoint = {
      id: randomId('cp'),
      projectId: this.projectId,
      createdAt: Date.now(),
      label,
      reason,
      files,
      fileCount: Object.keys(files).length,
      totalBytes: Object.values(files).reduce((n, f) => n + f.size, 0),
      messageIndex,
    };
    await db.putCheckpoint(checkpoint);
    return checkpoint;
  }

  listCheckpoints(): Promise<Checkpoint[]> {
    return db.listCheckpoints(this.projectId);
  }

  /**
   * Restore a checkpoint's file set. Chat is truncated to the point the checkpoint was
   * taken, because leaving later messages would describe edits that no longer exist.
   */
  async restoreCheckpoint(checkpointId: string): Promise<{ restored: number; removed: number }> {
    this.assertWritable();
    const checkpoint = await db.getCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.projectId !== this.projectId) {
      throw new Error('checkpoint not found for this project');
    }

    const missing: string[] = [];
    for (const entry of Object.values(checkpoint.files)) {
      if (!(await getBlobStore().has(entry.hash))) missing.push(entry.path);
    }
    if (missing.length) {
      throw new Error(
        `Checkpoint is incomplete: ${missing.length} blob(s) missing, first is ${missing[0]}`,
      );
    }

    const before = new Set(Object.keys(this.tree.files));
    this.tree.files = { ...checkpoint.files };
    await this.persistTree();

    if (checkpoint.messageIndex < this.messages.length) {
      this.messages = this.messages.slice(0, checkpoint.messageIndex);
      await db.clearMessages(this.projectId);
      for (const [i, m] of this.messages.entries()) {
        await db.appendMessage(this.projectId, m, i);
      }
    }

    const after = new Set(Object.keys(this.tree.files));
    return {
      restored: after.size,
      removed: [...before].filter((p) => !after.has(p)).length,
    };
  }

  /**
   * Drop blobs no live checkpoint or current tree references.
   *
   * Checkpoint-before-every-turn accumulates dead blobs as files are rewritten; without
   * this the OPFS quota is reached after a long session.
   */
  async collectGarbage(): Promise<{ deleted: number; freedBytes: number }> {
    this.assertWritable();
    const live = new Set<string>();
    for (const entry of Object.values(this.tree.files)) live.add(entry.hash);
    for (const cp of await db.listCheckpoints(this.projectId)) {
      for (const entry of Object.values(cp.files)) live.add(entry.hash);
    }

    const store = getBlobStore();
    let deleted = 0;
    let freedBytes = 0;
    for (const hash of await store.listHashes()) {
      if (live.has(hash)) continue;
      freedBytes += await store
        .get(hash)
        .then((b) => b.byteLength)
        .catch(() => 0);
      await store.delete(hash);
      deleted += 1;
    }
    return { deleted, freedBytes };
  }

  /** Keep the newest `keep` checkpoints, then sweep orphaned blobs. */
  async pruneCheckpoints(keep = 40): Promise<number> {
    this.assertWritable();
    const all = await db.listCheckpoints(this.projectId);
    const doomed = all.slice(keep);
    for (const cp of doomed) await db.deleteCheckpoint(cp.id);
    if (doomed.length) await this.collectGarbage();
    return doomed.length;
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  async appendMessage(message: ChatMessage): Promise<void> {
    this.assertWritable();
    this.messages.push(message);
    await db.appendMessage(this.projectId, message, this.messages.length - 1);
  }

  async updateMessage(message: ChatMessage): Promise<void> {
    this.assertWritable();
    const i = this.messages.findIndex((m) => m.id === message.id);
    if (i === -1) return this.appendMessage(message);
    this.messages[i] = message;
    await db.updateMessage(this.projectId, message, i);
  }

  async replaceChat(messages: ChatMessage[]): Promise<void> {
    this.assertWritable();
    this.messages = [...messages];
    await db.clearMessages(this.projectId);
    for (const [i, m] of this.messages.entries()) {
      await db.appendMessage(this.projectId, m, i);
    }
  }

  // -------------------------------------------------------------------------
  // Sandbox synchronization
  // -------------------------------------------------------------------------

  /**
   * Files eligible to be mirrored into the sandbox.
   *
   * Excludes dependencies and build output (the sandbox regenerates those), and excludes
   * credential files unconditionally -- a key must never reach the guest environment.
   */
  syncableFiles(): FileEntry[] {
    return Object.values(this.tree.files).filter(
      (f) => !isExcludedPath(f.path) && !isSecretPath(f.path),
    );
  }

  /**
   * Compare against a sandbox listing to decide the minimum upload set.
   * `remote` maps project-relative paths to content hashes.
   */
  diffAgainst(remote: Record<string, string>): {
    upload: FileEntry[];
    delete: string[];
    unchanged: number;
  } {
    const upload: FileEntry[] = [];
    let unchanged = 0;
    for (const entry of this.syncableFiles()) {
      if (remote[entry.path] === entry.hash) unchanged += 1;
      else upload.push(entry);
    }
    const local = new Set(this.syncableFiles().map((f) => f.path));
    return {
      upload,
      delete: Object.keys(remote).filter((p) => !local.has(p)),
      unchanged,
    };
  }
}
