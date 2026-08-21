import { describe, expect, it } from 'vitest';

import { buildProjectContext, buildSystemPrompt } from '../agent/prompt';
import { PROJECT_SCHEMA_VERSION } from '../core/limits';
import type { ProjectManifest } from '../core/types';

function manifest(): ProjectManifest {
  const now = Date.now();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name: 'trivia',
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

describe('system prompt', () => {
  const prompt = buildSystemPrompt({
    manifest: manifest(),
    capabilities: { streaming: true, functionCalling: true, vision: false },
    fileCount: 12,
    projectContext: '# trivia',
    isNewProject: false,
  });

  it('explains Mosaic preview vs Vercel join URLs in depth', () => {
    expect(prompt).toMatch(/sandbox\.mosaicos\.com\/preview/);
    expect(prompt).toMatch(/window\.location\.href/);
    expect(prompt).toMatch(/builder iframe/);
    expect(prompt).toMatch(/after Download ZIP/);
    expect(prompt).toMatch(/Do not use WebSockets/);
  });

  it('tells the model to persist notes in .builder/context.md across ZIP round-trips', () => {
    expect(prompt).toMatch(/\.builder\/context\.md/);
    expect(prompt).toMatch(/restored on re-import/);
    expect(prompt).toMatch(/1M tokens/);
  });

  it('requires reading a file before editing it and finishing with a real browser check', () => {
    expect(prompt).toMatch(/Never edit a file you have not read this turn/);
    expect(prompt).toMatch(/unopened page is not finished/);
  });

  it('includes the JeopardyLabs parse contract without requiring a dump in chat', () => {
    expect(prompt).toMatch(/\.front\.answer/);
    expect(prompt).toMatch(/uploads\//);
  });
});

describe('project context', () => {
  it('injects durable memory and lists uploads', () => {
    const text = buildProjectContext({
      manifest: manifest(),
      files: ['app/page.tsx', 'uploads/jeopardylabs-board.html', '.builder/context.md'],
      recentSummaries: ['Parsed the board.'],
      durableMemory: 'Rooms poll /api/game.',
    });
    expect(text).toContain('uploads/jeopardylabs-board.html');
    expect(text).toContain('Rooms poll /api/game.');
    expect(text).toContain('.builder/context.md');
  });
});
