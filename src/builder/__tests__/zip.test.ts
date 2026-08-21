/**
 * ZIP import and export.
 *
 * The export test that matters most is secret exclusion: an archive is the one artefact
 * the user hands to a third party, so a credential leaking into it is unrecoverable.
 */

import { zip } from 'fflate';
import { describe, expect, it } from 'vitest';

import { CHAT_LOG_PATH, PROJECT_MANIFEST_PATH, PROJECT_SCHEMA_VERSION } from '../core/limits';
import type { ChatMessage, ProjectManifest } from '../core/types';
import { exportZip, importZip, parseChatLog, readCentralDirectory, serializeChatLog } from '../transfer/zip';

const encoder = new TextEncoder();

function makeZip(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const input: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    input[name] = typeof content === 'string' ? encoder.encode(content) : content;
  }
  return new Promise((resolve, reject) => {
    zip(input, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function manifest(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  const now = Date.now();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name: 'zip-test',
    createdAt: now,
    updatedAt: now,
    framework: 'nextjs',
    packageManager: 'npm',
    commands: { install: 'npm install', dev: 'npm run dev', build: 'npm run build' },
    port: 3000,
    requiredEnv: ['DATABASE_URL'],
    capabilities: { database: true, auth: false, storage: false, payments: false },
    ...overrides,
  };
}

describe('readCentralDirectory', () => {
  it('reads names and sizes without inflating anything', async () => {
    const bytes = await makeZip({ 'package.json': '{"name":"x"}', 'app/page.tsx': 'export default 1;' });
    const entries = readCentralDirectory(bytes);
    expect(entries.map((e) => e.name).sort()).toEqual(['app/page.tsx', 'package.json']);
    expect(entries.every((e) => e.size > 0)).toBe(true);
  });

  it('rejects data that is not a ZIP', () => {
    expect(() => readCentralDirectory(encoder.encode('this is not a zip'))).toThrow(/Not a ZIP/);
  });
});

describe('importZip', () => {
  it('imports a generic project and infers its shape', async () => {
    const bytes = await makeZip({
      'package.json': JSON.stringify({ name: 'generic', dependencies: { next: '^15.0.0' } }),
      'package-lock.json': '{}',
      'app/page.tsx': 'export default function P() { return null; }',
    });
    const result = await importZip(bytes);
    expect(result.restoredFromBuilder).toBe(false);
    expect(result.manifest.framework).toBe('nextjs');
    expect(result.manifest.packageManager).toBe('npm');
    expect([...result.files.keys()].sort()).toEqual(['app/page.tsx', 'package-lock.json', 'package.json']);
  });

  it('detects pnpm from its lockfile', async () => {
    const bytes = await makeZip({
      'package.json': JSON.stringify({ name: 'p', dependencies: { vite: '^5' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'src/main.ts': 'console.log(1);',
    });
    const result = await importZip(bytes);
    expect(result.manifest.packageManager).toBe('pnpm');
    expect(result.manifest.framework).toBe('vite');
  });

  it('strips a single wrapping directory', async () => {
    const bytes = await makeZip({
      'my-app/package.json': '{"name":"wrapped"}',
      'my-app/app/page.tsx': 'x',
    });
    const result = await importZip(bytes);
    expect([...result.files.keys()].sort()).toEqual(['app/page.tsx', 'package.json']);
  });

  it('restores chat and settings from a builder archive', async () => {
    const chat: ChatMessage[] = [
      { id: 'm1', role: 'user', content: 'build me a thing', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'done', createdAt: 2 },
    ];
    const bytes = await makeZip({
      'package.json': '{"name":"restored"}',
      [PROJECT_MANIFEST_PATH]: JSON.stringify(manifest({ name: 'restored-name' })),
      [CHAT_LOG_PATH]: serializeChatLog(chat),
    });

    const result = await importZip(bytes);
    expect(result.restoredFromBuilder).toBe(true);
    expect(result.manifest.name).toBe('restored-name');
    expect(result.chat.map((m) => m.content)).toEqual(['build me a thing', 'done']);
    // Metadata is consumed, not left lying around as project source.
    expect([...result.files.keys()].some((p) => p.startsWith('.builder/'))).toBe(false);
  });

  it('falls back to detection when the manifest schema is from another version', async () => {
    const bytes = await makeZip({
      'package.json': JSON.stringify({ name: 'future', dependencies: { next: '^15' } }),
      [PROJECT_MANIFEST_PATH]: JSON.stringify({ ...manifest(), schemaVersion: 999 }),
    });
    const result = await importZip(bytes);
    expect(result.restoredFromBuilder).toBe(false);
    expect(result.audit.warnings.some((w) => w.includes('schema'))).toBe(true);
  });

  it('drops credential files and says so', async () => {
    const bytes = await makeZip({
      'package.json': '{"name":"x"}',
      '.env': 'OPENAI_API_KEY=sk-leaked-value',
      '.env.example': 'OPENAI_API_KEY=',
    });
    const result = await importZip(bytes);
    expect(result.files.has('.env')).toBe(false);
    expect(result.files.has('.env.example')).toBe(true);
    expect(JSON.stringify([...result.files])).not.toContain('sk-leaked-value');
  });

  it('refuses an archive whose entries all traverse', async () => {
    const bytes = await makeZip({ '../../etc/passwd': 'root:x:0:0', '../evil.sh': '#!/bin/sh' });
    await expect(importZip(bytes)).rejects.toThrow(/no importable files/);
  });

  it('survives a malformed chat log by keeping the complete lines', () => {
    const parsed = parseChatLog(
      '{"id":"a","role":"user","content":"one","createdAt":1}\n{"id":"b","role":"assis',
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].content).toBe('one');
  });
});

describe('exportZip', () => {
  const files = new Map<string, Uint8Array>([
    ['package.json', encoder.encode('{"name":"exported"}')],
    ['app/page.tsx', encoder.encode('export default function P() { return null; }')],
    ['public/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])],
  ]);

  it('produces an archive Vercel Drop can build, with source at the root', async () => {
    const result = await exportZip({ manifest: manifest(), files, chat: [], context: '# ctx' });
    const entries = readCentralDirectory(result.bytes).map((e) => e.name);
    expect(entries).toContain('package.json');
    expect(entries).toContain('app/page.tsx');
    expect(entries).toContain('vercel.json');
    expect(entries).toContain('.vercelignore');
    expect(entries).toContain('DEPLOYMENT.md');
    expect(entries).toContain('.env.example');
  });

  it('round-trips through import unchanged', async () => {
    const chat: ChatMessage[] = [{ id: 'm1', role: 'user', content: 'hello', createdAt: 1 }];
    const exported = await exportZip({ manifest: manifest({ name: 'roundtrip' }), files, chat, context: '# ctx' });
    const imported = await importZip(exported.bytes);

    expect(imported.manifest.name).toBe('roundtrip');
    expect(imported.chat.map((m) => m.content)).toEqual(['hello']);
    expect(imported.files.get('app/page.tsx')).toBeDefined();
    // Binary assets must survive byte for byte.
    expect(Array.from(imported.files.get('public/logo.png')!)).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
  });

  it('never writes a credential into the archive', async () => {
    const withSecrets = new Map(files);
    withSecrets.set('.env', encoder.encode('DATABASE_URL=postgres://user:hunter2@host/db'));
    withSecrets.set('.env.local', encoder.encode('OPENAI_API_KEY=sk-live-do-not-ship'));
    withSecrets.set('deploy/id_rsa', encoder.encode('-----BEGIN PRIVATE KEY-----'));

    const result = await exportZip({ manifest: manifest(), files: withSecrets, chat: [], context: '' });
    const entries = readCentralDirectory(result.bytes).map((e) => e.name);

    expect(entries).not.toContain('.env');
    expect(entries).not.toContain('.env.local');
    expect(entries).not.toContain('deploy/id_rsa');
    expect(result.excluded.sort()).toEqual(['.env', '.env.local', 'deploy/id_rsa']);

    // Scan the raw bytes: the values must not appear anywhere, including in metadata.
    const raw = Buffer.from(result.bytes).toString('binary');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('sk-live-do-not-ship');
    expect(raw).not.toContain('BEGIN PRIVATE KEY');
  });

  it('keeps chat out when the user asks for a clean archive', async () => {
    const chat: ChatMessage[] = [{ id: 'm1', role: 'user', content: 'private conversation', createdAt: 1 }];
    const result = await exportZip({ manifest: manifest(), files, chat, includeChat: false, context: '' });
    const entries = readCentralDirectory(result.bytes).map((e) => e.name);
    expect(entries).not.toContain(CHAT_LOG_PATH);
    expect(Buffer.from(result.bytes).toString('binary')).not.toContain('private conversation');
  });

  it('excludes .builder and real env files from the deployment', async () => {
    const result = await exportZip({ manifest: manifest(), files, chat: [], context: '' });
    const imported = await importZip(result.bytes);
    // .vercelignore ships in the archive but is consumed by Vercel, not by the importer.
    const ignore = new TextDecoder().decode(
      (await importZip(result.bytes)).files.get('.vercelignore') ?? new Uint8Array(),
    );
    expect(ignore).toContain('.builder/');
    expect(ignore).toContain('.env');
    expect(ignore).toContain('!.env.example');
    expect(imported.manifest.name).toBe('zip-test');
  });

  it('documents the database setup contract for a database project', async () => {
    const result = await exportZip({ manifest: manifest(), files, chat: [], context: '' });
    const imported = await importZip(result.bytes);
    const doc = new TextDecoder().decode(imported.files.get('DEPLOYMENT.md')!);
    expect(doc).toContain('succeeds without');
    expect(doc).toContain('DATABASE_URL');
    expect(doc).toContain('vercel.com/drop');
  });
});
