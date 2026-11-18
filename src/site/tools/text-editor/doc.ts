/* The document side of the editor: languages, file names, counts, storage. */

export type Lang = 'text' | 'markdown' | 'javascript' | 'python' | 'cpp' | 'java' | 'html';

export const LANGS: { id: Lang; label: string; ext: string }[] = [
  { id: 'text', label: 'Plain text', ext: 'txt' },
  { id: 'markdown', label: 'Markdown', ext: 'md' },
  { id: 'javascript', label: 'JavaScript', ext: 'js' },
  { id: 'python', label: 'Python', ext: 'py' },
  { id: 'cpp', label: 'C++', ext: 'cpp' },
  { id: 'java', label: 'Java', ext: 'java' },
  { id: 'html', label: 'HTML', ext: 'html' },
];

const EXT_LANG: Record<string, Lang> = {
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', mkd: 'markdown', mdown: 'markdown',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'javascript', tsx: 'javascript', mts: 'javascript', cts: 'javascript', json: 'javascript',
  py: 'python', pyw: 'python', pyi: 'python',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp', ino: 'cpp',
  java: 'java',
  html: 'html', htm: 'html', xhtml: 'html',
};

export const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

const extFor = (lang: Lang) => LANGS.find((l) => l.id === lang)!.ext;

/** Writing rather than code: these get a reading measure. */
export const isProse = (lang: Lang) => lang === 'text' || lang === 'markdown';

/** The language a file name implies; anything unknown is plain text. */
export const langOf = (name: string): Lang => EXT_LANG[extOf(name)] ?? 'text';

/** Only a code extension is worth switching the highlighting for. */
export const codeLangOf = (name: string): Lang | null => EXT_LANG[extOf(name)] ?? null;

/** Choosing a language carries the file name along with it. */
export function withLang(name: string, lang: Lang): string {
  const ext = extOf(name);
  if (!ext) return `${name || 'untitled'}.${extFor(lang)}`;
  if (langOf(name) === lang) return name;
  return `${name.slice(0, -ext.length)}${extFor(lang)}`;
}

/** A name that is safe to download as; an empty one becomes untitled. */
export function cleanName(name: string, lang: Lang): string {
  // eslint-disable-next-line no-control-regex
  const n = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').trim();
  return n && n !== '.' && n !== '..' ? n : `untitled.${extFor(lang)}`;
}

/**
  The indent a document already uses: tabs, or the most common step between
  indented lines. Without evidence, the language's own convention.
*/
export function detectIndent(text: string, lang: Lang): string {
  let tabbed = 0;
  let spaced = 0;
  let prev = 0;
  const steps = new Map<number, number>();
  const lines = text.length > 400_000 ? text.slice(0, 400_000).split('\n') : text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)![0];
    if (lead.startsWith('\t')) {
      tabbed++;
      continue;
    }
    const w = lead.length;
    if (w) spaced++;
    const step = Math.abs(w - prev);
    prev = w;
    if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
  }
  if (tabbed > spaced && tabbed > 0) return '\t';
  let best = 0;
  let seen = 0;
  for (const [step, n] of steps) if (n > seen || (n === seen && step < best)) [best, seen] = [step, n];
  if (best) return ' '.repeat(best);
  return ' '.repeat(lang === 'python' || lang === 'java' || lang === 'cpp' ? 4 : 2);
}

export type Counts = { lines: number; words: number; chars: number };

export function countText(text: string): Counts {
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
  const words = text.match(/\S+/g)?.length ?? 0;
  const astral = text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0;
  return { lines, words, chars: text.length - astral };
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export const formatCounts = (c: Counts) =>
  `${plural(c.lines, 'line', 'lines')}, ${plural(c.words, 'word', 'words')}, ${plural(c.chars, 'character', 'characters')}`;

/* ── Keeping the document across reloads ─────────────────────── */

export type Saved = { doc: string; name: string; lang: Lang; wrap: boolean };
const KEY = 'dm.text-editor.v1';

export function loadSaved(): Saved | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.doc !== 'string' || typeof v?.name !== 'string') return null;
    const lang: Lang = LANGS.some((l) => l.id === v.lang) ? v.lang : langOf(v.name);
    return { doc: v.doc, name: v.name, lang, wrap: v.wrap !== false };
  } catch {
    return null;
  }
}

/** False when the browser won’t hold it (private mode, quota). */
export function storeSaved(s: Saved): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}
