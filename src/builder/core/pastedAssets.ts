/**
 * Keep giant dumps out of the model context.
 *
 * A JeopardyLabs "download board" HTML file is mostly CSS and layout script. The clues
 * are a few kilobytes. If the whole dump goes into chat, the turn has no room left to
 * actually write the game. We save the bytes as a project file and tell the agent the path.
 */

export const LARGE_PASTE_CHARS = 12_000;

export interface PastedFile {
  path: string;
  content: string;
}

export function safeUploadName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() || 'upload';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 80) || 'upload';
}

export function looksLikeJeopardyHtml(html: string): boolean {
  return /jeopardylabs|grid-row-cats|class="front answer"|class="back question"/i.test(html);
}

/**
 * If the user pasted a full HTML document into the composer, peel it off into a file
 * and leave the instructions behind.
 */
export function extractOversizedMarkup(prompt: string): {
  prompt: string;
  instructions: string;
  file: PastedFile | null;
} {
  const doctype = prompt.search(/<!DOCTYPE\s+html/i);
  if (doctype < 0) return { prompt, instructions: prompt, file: null };
  const html = prompt.slice(doctype).trim();
  if (html.length < LARGE_PASTE_CHARS) return { prompt, instructions: prompt, file: null };

  const instructions = prompt.slice(0, doctype).trim();
  const path = looksLikeJeopardyHtml(html) ? 'uploads/jeopardylabs-board.html' : 'uploads/pasted.html';
  const note = `The pasted HTML (${html.length} characters) is saved at ${path}. Parse that file with a script. Do not echo it back.`;
  return {
    prompt: [instructions, note].filter(Boolean).join('\n\n'),
    instructions,
    file: { path, content: html },
  };
}
