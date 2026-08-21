/**
 * ZIP import and export, entirely in the browser.
 *
 * Export never touches a server, which is the mechanism behind "chat is not saved in the
 * cloud": the archive containing the conversation is assembled from OPFS and IndexedDB in
 * the tab and handed straight to a download.
 *
 * Import runs every entry through auditArchive first, then unzips only what survived, so
 * a malicious archive never reaches the extraction step at all.
 */

import { unzip, zip, type Unzipped, type Zippable } from 'fflate';

import {
  BUILDER_METADATA_DIR,
  CHAT_LOG_PATH,
  CONTEXT_PATH,
  PROJECT_MANIFEST_PATH,
  PROJECT_SCHEMA_VERSION,
} from '../core/limits';
import { isSecretPath } from '../core/paths';
import type { ChatMessage, ProjectManifest } from '../core/types';
import {
  ArchiveRejected,
  auditArchive,
  detectRootPrefix,
  stripRootPrefix,
  type ArchiveAudit,
  type RawArchiveEntry,
} from './archive';
import { detectProject } from './detect';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function unzipAsync(bytes: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function zipAsync(files: Zippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportedProject {
  manifest: ProjectManifest;
  files: Map<string, Uint8Array>;
  chat: ChatMessage[];
  context: string | null;
  audit: ArchiveAudit;
  /** True when the archive carried .builder metadata, i.e. it was exported by this builder. */
  restoredFromBuilder: boolean;
}

/**
 * Read the ZIP's central directory without inflating anything.
 *
 * fflate's unzip inflates eagerly, which would defeat the point of a zip-bomb check, so
 * the header is parsed by hand to get sizes and Unix modes before any decompression.
 */
export function readCentralDirectory(bytes: Uint8Array): RawArchiveEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Find the End of Central Directory record by scanning back from the tail; the comment
  // field means it is not at a fixed offset.
  let eocd = -1;
  const scanFrom = Math.max(0, bytes.length - 66_000);
  for (let i = bytes.length - 22; i >= scanFrom; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ArchiveRejected('Not a ZIP archive (no end-of-central-directory record).');

  let count = view.getUint16(eocd + 10, true);
  let dirOffset = view.getUint32(eocd + 16, true);

  // ZIP64: the 32-bit fields saturate and the real values live in the ZIP64 EOCD.
  if (count === 0xffff || dirOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && view.getUint32(locator, true) === 0x07064b50) {
      const z64 = Number(view.getBigUint64(locator + 8, true));
      if (view.getUint32(z64, true) === 0x06064b50) {
        count = Number(view.getBigUint64(z64 + 32, true));
        dirOffset = Number(view.getBigUint64(z64 + 48, true));
      }
    }
  }

  const entries: RawArchiveEntry[] = [];
  let p = dirOffset;
  for (let i = 0; i < count && p + 46 <= bytes.length; i += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const versionMadeBy = view.getUint16(p + 4, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const externalAttrs = view.getUint32(p + 38, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // The high byte of versionMadeBy is the source OS; 3 is Unix, and only then does the
    // high word of externalAttrs carry a st_mode we can trust.
    const madeByUnix = versionMadeBy >> 8 === 3;
    const mode = madeByUnix ? externalAttrs >>> 16 : undefined;

    entries.push({
      name,
      size,
      compressedSize,
      mode,
      isDirectory: name.endsWith('/') || (mode !== undefined && (mode & 0o170000) === 0o040000),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (entries.length === 0) throw new ArchiveRejected('ZIP archive contains no entries.');
  return entries;
}

export async function importZip(bytes: Uint8Array, fallbackName = 'imported-project'): Promise<ImportedProject> {
  const rawEntries = readCentralDirectory(bytes);

  // Strip a single wrapping directory before auditing so path rules apply to the paths we
  // will actually use.
  const prefix = detectRootPrefix(rawEntries.filter((e) => !e.isDirectory).map((e) => e.name));
  const normalized = rawEntries.map((e) => ({ ...e, name: stripRootPrefix(e.name, prefix) }));

  const audit = auditArchive(normalized);
  const wanted = new Map(audit.accepted.map((a) => [prefix ? `${prefix}/${a.name}` : a.name, a.path]));

  const unzipped = await unzipAsync(bytes);

  const files = new Map<string, Uint8Array>();
  let actualBytes = 0;
  for (const [rawName, content] of Object.entries(unzipped)) {
    const target = wanted.get(rawName);
    if (!target) continue;
    // The central directory is attacker-controlled metadata. Re-check the real inflated
    // size so a lying header cannot smuggle a bomb past the audit.
    actualBytes += content.length;
    if (actualBytes > 100 * 1024 * 1024) {
      throw new ArchiveRejected(
        'Archive inflated to more than its declared size and exceeded the 100 MB limit.',
        audit,
      );
    }
    files.set(target, content);
  }

  // .builder metadata restores a prior session exactly; without it we infer everything.
  const manifestBytes = files.get(PROJECT_MANIFEST_PATH);
  let manifest: ProjectManifest | null = null;
  if (manifestBytes) {
    try {
      const parsed = JSON.parse(decoder.decode(manifestBytes)) as ProjectManifest;
      if (parsed.schemaVersion === PROJECT_SCHEMA_VERSION) manifest = parsed;
      else audit.warnings.push(
        `Ignoring .builder/project.json written by schema v${parsed.schemaVersion}; this build reads v${PROJECT_SCHEMA_VERSION}.`,
      );
    } catch {
      audit.warnings.push('.builder/project.json is not valid JSON; falling back to detection.');
    }
  }

  const chat = manifestBytes || files.has(CHAT_LOG_PATH)
    ? parseChatLog(decoder.decode(files.get(CHAT_LOG_PATH) ?? new Uint8Array()))
    : [];
  const context = files.has(CONTEXT_PATH) ? decoder.decode(files.get(CONTEXT_PATH)!) : null;

  // .builder/project.json and chat.jsonl are restored into IndexedDB, not as source.
  // .builder/context.md stays in the tree so download → re-import still has durable notes.
  for (const p of [...files.keys()]) {
    if (p.startsWith(`${BUILDER_METADATA_DIR}/`) && p !== CONTEXT_PATH) files.delete(p);
  }

  const resolved =
    manifest ??
    detectProject({
      paths: [...files.keys()],
      read: (p) => {
        const b = files.get(p);
        return b ? decoder.decode(b) : undefined;
      },
      fallbackName,
    });

  return {
    manifest: { ...resolved, updatedAt: Date.now() },
    files,
    chat,
    context,
    audit,
    restoredFromBuilder: manifest !== null,
  };
}

/** JSON Lines, so a truncated export still restores every complete message before the cut. */
export function parseChatLog(text: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ChatMessage;
      if (parsed && typeof parsed.id === 'string' && typeof parsed.role === 'string') out.push(parsed);
    } catch {
      /* skip the partial line rather than losing the whole conversation */
    }
  }
  return out;
}

export function serializeChatLog(messages: readonly ChatMessage[]): string {
  return messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '');
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportInput {
  manifest: ProjectManifest;
  /** Project-relative path to bytes. Callers pass the current tree, not a checkpoint. */
  files: Map<string, Uint8Array>;
  chat: readonly ChatMessage[];
  context: string;
  /** Set false for a clean hand-off archive with no conversation history. */
  includeChat?: boolean;
}

export interface ExportResult {
  bytes: Uint8Array;
  fileCount: number;
  /** Paths withheld because they matched a credential pattern. */
  excluded: string[];
}

/**
 * Build the portable ZIP.
 *
 * Source sits at the archive root so Vercel Drop detects the framework. `.builder/` and
 * real `.env` files are excluded by `.vercelignore` from the deployment but kept in the
 * archive (metadata) or dropped entirely (secrets).
 */
export async function exportZip(input: ExportInput): Promise<ExportResult> {
  const entries: Zippable = {};
  const excluded: string[] = [];

  for (const [path, bytes] of input.files) {
    if (isSecretPath(path)) {
      excluded.push(path);
      continue;
    }
    entries[path] = bytes;
  }

  if (!('vercel.json' in entries)) {
    entries['vercel.json'] = encoder.encode(renderVercelJson(input.manifest));
  }
  entries['.vercelignore'] = encoder.encode(renderVercelIgnore());
  if (!('.env.example' in entries)) {
    entries['.env.example'] = encoder.encode(renderEnvExample(input.manifest));
  }
  entries['DEPLOYMENT.md'] = encoder.encode(renderDeploymentDoc(input.manifest));

  entries[PROJECT_MANIFEST_PATH] = encoder.encode(
    JSON.stringify({ ...input.manifest, updatedAt: Date.now() }, null, 2) + '\n',
  );
  // Prefer the live `.builder/context.md` from the tree; fall back to the generated string.
  if (!entries[CONTEXT_PATH]) {
    entries[CONTEXT_PATH] = encoder.encode(input.context);
  }
  if (input.includeChat !== false) {
    entries[CHAT_LOG_PATH] = encoder.encode(serializeChatLog(input.chat));
  }

  return {
    bytes: await zipAsync(entries),
    fileCount: Object.keys(entries).length,
    excluded,
  };
}

function renderVercelJson(manifest: ProjectManifest): string {
  const config: Record<string, unknown> = { $schema: 'https://openapi.vercel.sh/vercel.json' };
  if (manifest.framework === 'nextjs') config.framework = 'nextjs';
  else if (manifest.framework === 'vite') {
    config.framework = 'vite';
    config.outputDirectory = 'dist';
  }
  return JSON.stringify(config, null, 2) + '\n';
}

function renderVercelIgnore(): string {
  return `# Local builder metadata: chat history and project settings. Not part of the deployment.
.builder/

# Real environment files never leave your browser; .env.example is intentionally kept.
.env
.env.*
!.env.example

node_modules/
.git/
.next/
.turbo/
.vercel/
dist/
build/
out/
coverage/
*.log
.DS_Store
`;
}

function renderEnvExample(manifest: ProjectManifest): string {
  const lines = [
    '# Copy to .env.local for local development, or set these in your Vercel project.',
    '# Names only: this file never contains values.',
    '',
  ];
  if (manifest.capabilities.database && !manifest.requiredEnv.includes('DATABASE_URL')) {
    lines.push('# Postgres connection string. Connect Neon or Supabase in the Vercel Marketplace');
    lines.push('# and Vercel injects this automatically.');
    lines.push('DATABASE_URL=');
    lines.push('');
  }
  for (const name of manifest.requiredEnv) lines.push(`${name}=`);
  return lines.join('\n') + '\n';
}

function renderDeploymentDoc(manifest: ProjectManifest): string {
  const needsDb = manifest.capabilities.database;
  return `# Deploying this project

This archive is plain source. It carries no credentials and no hosted database contents,
which is why it is portable.

## Option 1: Vercel Drop (no Git)

1. Open https://vercel.com/drop
2. Drag this ZIP onto the page.

Vercel detects the framework, builds it, and gives you a URL.

Vercel Drop creates a *new* project for every drop. To keep updating one URL, connect a Git
repository or use \`vercel --prod\` from the Vercel CLI instead.

## Option 2: Vercel CLI

\`\`\`bash
npm i -g vercel
vercel
\`\`\`

## Environment variables

${
  manifest.requiredEnv.length
    ? `This project reads the following variables. Set them under Project Settings -> Environment Variables:

${manifest.requiredEnv.map((n) => `- \`${n}\``).join('\n')}`
    : 'This project needs no environment variables to build.'
}

${
  needsDb
    ? `## Database

The first build **succeeds without \`DATABASE_URL\`**. The app runs in a clearly labelled
demo mode and \`/setup\` shows what is missing, so a missing credential is never a failed
deployment.

To make it persistent:

1. In your Vercel project, open **Storage** and connect a Postgres provider (Neon,
   Supabase, or any Marketplace Postgres).
2. Vercel injects \`DATABASE_URL\` into the project.
3. Redeploy.

On that redeploy the migration script runs before \`next build\`. It is idempotent and takes
a Postgres advisory lock, so parallel builds cannot apply the same migration twice.

Your data lives in your own database. It was never in this archive and never on the
builder's servers.`
    : ''
}

## What is not in this archive

- API keys and secret values of any kind.
- Hosted database contents.
- Your model provider key, which never left your browser's memory.

\`.builder/\` holds your chat history and project settings so re-importing the ZIP restores
the session. \`.vercelignore\` keeps it out of the deployment.
`;
}

/** Fire a browser download for an exported archive. */
export function downloadZip(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.zip') ? filename : `${filename}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
