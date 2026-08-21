import { describe, expect, it } from 'vitest';

import {
  compactTurnMessages,
  COMPACT,
  prepareHistory,
  recentWorkSummaries,
  seedDurableContext,
  upsertFilesSection,
} from '../agent/compact';
import type { ChatMessage } from '../core/types';
import type { TurnMessage } from '../agent/providers/types';

function msg(role: 'user' | 'assistant', content: string, i: number): ChatMessage {
  return { id: `m${i}`, role, content, createdAt: i };
}

describe('prepareHistory', () => {
  it('keeps a short thread intact', () => {
    const messages = [msg('user', 'make a todo', 1), msg('assistant', 'done', 2)];
    const { history, earlierDigest } = prepareHistory(messages);
    expect(history).toHaveLength(2);
    expect(earlierDigest).toBe('');
  });

  it('does not compact just because there are many short turns', () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`, i),
    );
    const { history, earlierDigest } = prepareHistory(messages);
    expect(history).toHaveLength(40);
    expect(earlierDigest).toBe('');
  });

  it('folds oldest turns only after the character budget is exceeded', () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `turn-${i} ${'x'.repeat(70_000)}`, i),
    );
    const { history, earlierDigest } = prepareHistory(messages);
    expect(earlierDigest).toContain('turn-0');
    expect(history.length).toBeGreaterThanOrEqual(COMPACT.minHistoryMessages);
    expect(history.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(
      COMPACT.maxHistoryChars + COMPACT.maxHistoryMessageChars,
    );
  });

  it('clips a giant message so one dump cannot fill the window', () => {
    const { history } = prepareHistory([msg('user', 'y'.repeat(COMPACT.maxHistoryMessageChars + 50_000), 1)]);
    expect(history[0].content.length).toBeLessThan(COMPACT.maxHistoryMessageChars + 80);
    expect(history[0].content).toContain('truncated');
  });
});

describe('recentWorkSummaries', () => {
  it('takes the last assistant replies as one-liners', () => {
    const out = recentWorkSummaries([
      msg('user', 'hi', 1),
      msg('assistant', 'Added polling rooms.', 2),
      msg('assistant', '  Wired  share  link.  ', 3),
    ]);
    expect(out).toEqual(['Added polling rooms.', 'Wired share link.']);
  });
});

describe('compactTurnMessages', () => {
  it('leaves tool results intact while this turn is under budget', () => {
    const messages: TurnMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'tool',
        toolCallId: 'c0',
        name: 'fs_read',
        content: 'Z'.repeat(20_000),
      },
    ];
    compactTurnMessages(messages);
    expect(messages[1].role === 'tool' && messages[1].content.length).toBe(20_000);
  });

  it('shrinks oldest tool results when this turn overflows', () => {
    const messages: TurnMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 8; i += 1) {
      messages.push({
        role: 'tool',
        toolCallId: `c${i}`,
        name: 'fs_read',
        content: 'Z'.repeat(80_000),
      });
    }
    compactTurnMessages(messages);
    const tools = messages.filter((m) => m.role === 'tool');
    expect(tools[0].content.length).toBeLessThan(COMPACT.olderToolChars + 80);
    expect(tools[tools.length - 1].content.length).toBeGreaterThan(COMPACT.olderToolChars);
    expect(tools[0].content).toContain('compacted');
  });
});

describe('durable context file', () => {
  it('seeds share/join notes and a file list', () => {
    const text = seedDurableContext({ name: 'trivia', files: ['app/page.tsx', 'uploads/board.html'] });
    expect(text).toContain('ZIP');
    expect(text).toContain('sandbox.mosaicos.com');
    expect(text).toContain('uploads/board.html');
  });

  it('refreshes the file list without wiping architecture notes', () => {
    const existing = seedDurableContext({ name: 'trivia', files: ['app/page.tsx'] });
    const withNote = existing.replace(
      '(Routes, where live state lives, polling vs database.)',
      'Rooms in a Map; poll /api/game.',
    );
    const next = upsertFilesSection(withNote, ['app/page.tsx', 'app/api/game/route.ts']);
    expect(next).toContain('Rooms in a Map');
    expect(next).toContain('app/api/game/route.ts');
  });
});
