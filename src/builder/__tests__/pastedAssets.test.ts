import { describe, expect, it } from 'vitest';

import {
  extractOversizedMarkup,
  LARGE_PASTE_CHARS,
  looksLikeJeopardyHtml,
  safeUploadName,
} from '../core/pastedAssets';

describe('pasted assets', () => {
  it('sanitises upload names', () => {
    expect(safeUploadName('../../board.html')).toBe('board.html');
    expect(safeUploadName('My Board (2).HTML')).toBe('My-Board-2-.HTML');
  });

  it('recognises a JeopardyLabs play-mode export', () => {
    expect(looksLikeJeopardyHtml('<div class="front answer"><p>100-75=</p></div>')).toBe(true);
    expect(looksLikeJeopardyHtml('<html><body>hello</body></html>')).toBe(false);
  });

  it('leaves short pastes in the prompt', () => {
    const prompt = 'Build a game.\n<!DOCTYPE html><html><body>tiny</body></html>';
    expect(extractOversizedMarkup(prompt).file).toBeNull();
    expect(extractOversizedMarkup(prompt).prompt).toBe(prompt);
    expect(extractOversizedMarkup(prompt).instructions).toBe(prompt);
  });

  it('stashes a giant HTML dump as a file and keeps the instructions', () => {
    const html = `<!DOCTYPE html><html><body class="front answer">${'x'.repeat(LARGE_PASTE_CHARS)}</body></html>`;
    const prompt = `Everyone answers at once.\n\n${html}`;
    const out = extractOversizedMarkup(prompt);
    expect(out.file?.path).toBe('uploads/jeopardylabs-board.html');
    expect(out.file?.content.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out.instructions).toBe('Everyone answers at once.');
    expect(out.prompt).toContain('Everyone answers at once.');
    expect(out.prompt).toContain('uploads/jeopardylabs-board.html');
    expect(out.prompt.includes('<!DOCTYPE')).toBe(false);
  });
});
