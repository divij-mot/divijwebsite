/**
 * Keep the model’s window useful as a project grows.
 *
 * The provider window is about a million tokens. Do not compact on turn count. Fold
 * oldest chat only when the character budget is actually exceeded; same for this-turn
 * tool JSON. Durable notes live in `.builder/context.md` and survive ZIP export/import.
 */

import type { ChatMessage } from '../core/types';
import type { TurnMessage } from './providers/types';

export const COMPACT = {
  /**
   * Prior chat sent to the model. ~300k tokens at 4 chars/token, leaving headroom in a
   * 1M-token window for the system prompt, tools, and this turn’s tool results.
   */
  maxHistoryChars: 1_200_000,
  /** Clip a single message only if it is a dump (HTML board, log paste). */
  maxHistoryMessageChars: 120_000,
  digestLineChars: 400,
  /** Sum of tool JSON in this turn before oldest results are shrunk. */
  maxTurnToolChars: 400_000,
  recentToolChars: 80_000,
  olderToolChars: 8_000,
  keepRecentToolResults: 8,
  /** Always keep at least this many history messages, even when over budget. */
  minHistoryMessages: 4,
  durableMemoryChars: 80_000,
} as const;

function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…[truncated ${t.length - max} characters]`;
}

function clipMessage(m: ChatMessage): ChatMessage {
  if (m.content.length <= COMPACT.maxHistoryMessageChars) return m;
  return { ...m, content: clip(m.content, COMPACT.maxHistoryMessageChars) };
}

/**
 * Send the full thread until it would overflow. Only then fold oldest turns into a
 * digest for project context.
 */
export function prepareHistory(messages: readonly ChatMessage[]): {
  history: ChatMessage[];
  earlierDigest: string;
} {
  const usable = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .map(clipMessage);

  let total = usable.reduce((n, m) => n + m.content.length, 0);
  if (total <= COMPACT.maxHistoryChars) {
    return { history: usable, earlierDigest: '' };
  }

  const older: ChatMessage[] = [];
  let split = 0;
  const floor = Math.min(COMPACT.minHistoryMessages, usable.length);
  while (split < usable.length - floor && total > COMPACT.maxHistoryChars) {
    older.push(usable[split]);
    total -= usable[split].content.length;
    split += 1;
  }

  const earlierDigest = older
    .map((m) => `- ${m.role}: ${clip(m.content.replace(/\s+/g, ' '), COMPACT.digestLineChars)}`)
    .join('\n');

  return { history: usable.slice(split), earlierDigest };
}

export function recentWorkSummaries(messages: readonly ChatMessage[]): string[] {
  return messages
    .filter((m) => m.role === 'assistant' && m.content.trim())
    .slice(-8)
    .map((m) => m.content.replace(/\s+/g, ' ').trim().slice(0, 400));
}

/**
 * Shrink this-turn tool payloads only when their combined size exceeds the budget.
 * Oldest results go first so the latest reads stay useful.
 */
export function compactTurnMessages(messages: TurnMessage[]): void {
  const toolIndexes: number[] = [];
  let total = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.role !== 'tool') continue;
    toolIndexes.push(i);
    total += msg.content.length;
  }
  if (total <= COMPACT.maxTurnToolChars) return;

  const shrink = (indexes: number[], cap: number) => {
    for (const i of indexes) {
      if (total <= COMPACT.maxTurnToolChars) return;
      const msg = messages[i];
      if (msg.role !== 'tool' || msg.content.length <= cap) continue;
      const name = msg.name || 'tool';
      const before = msg.content.length;
      msg.content = `${clip(msg.content, cap)}\n…[${name} output compacted]`;
      total -= before - msg.content.length;
    }
  };

  const recent = toolIndexes.slice(-COMPACT.keepRecentToolResults);
  const older = toolIndexes.slice(0, -COMPACT.keepRecentToolResults);
  shrink(older, COMPACT.olderToolChars);
  if (total > COMPACT.maxTurnToolChars) shrink(toolIndexes.slice(0, -1), COMPACT.olderToolChars);
  shrink(recent, COMPACT.recentToolChars);
}

const FILES_HEADER = '## Files (live tree)';

export function seedDurableContext(input: { name: string; files: string[] }): string {
  return [
    `# Durable memory — ${input.name}`,
    '',
    'This file is the project’s long-term notes. It is stored in the browser, included in',
    'the ZIP, and restored on re-import. It is *not* deployed to Vercel (`.vercelignore`).',
    'Keep architecture, API shapes, room protocol, and how Share/join works here.',
    '',
    '## Product',
    '',
    '(What this app is, who uses it.)',
    '',
    '## Architecture',
    '',
    '(Routes, where live state lives, polling vs database.)',
    '',
    '## Share and join',
    '',
    '- While in the Mosaic sandbox, the join URL is the public preview',
    '  (`https://sandbox.mosaicos.com/preview/<token>/`). Copy `window.location.href` from',
    '  that tab — not from the builder iframe.',
    '- After a Vercel deploy, the join URL is the deployment origin. The same',
    '  `window.location.href` Share control is correct there.',
    '',
    filesSection(input.files),
  ].join('\n');
}

function filesSection(files: string[]): string {
  const shown = files.slice(0, 150);
  return [
    FILES_HEADER,
    '',
    `${files.length} files.`,
    ...shown.map((f) => `- ${f}`),
    files.length > shown.length ? `- ...and ${files.length - shown.length} more` : '',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Refresh the live file list without erasing the agent’s notes. */
export function upsertFilesSection(existing: string, files: string[]): string {
  const block = `${filesSection(files)}\n`;
  if (!existing.trim()) return seedDurableContext({ name: 'app', files });
  const re = /## Files \(live tree\)[\s\S]*?(?=\n## (?!Files)|\n# [^#]|$)/;
  if (re.test(existing)) return existing.replace(re, block);
  return `${existing.trimEnd()}\n\n${block}`;
}

export function clipDurableMemory(text: string): string {
  return clip(text.trim(), COMPACT.durableMemoryChars);
}
