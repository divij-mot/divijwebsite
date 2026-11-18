/* Tables: CSV, TSV and JSON into one another. */

type Cell = string | number | boolean | null;

/** RFC 4180 parsing: quoted fields, doubled quotes, line breaks inside quotes. */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
    } else if (c === sep) {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // blank lines carry nothing
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function typed(v: string): Cell {
  if (NUMBER.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n) || !/^-?\d+$/.test(v)) return n;
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  return v;
}

function headerNames(row: string[]): string[] {
  const seen = new Map<string, number>();
  return row.map((h, i) => {
    let name = h.trim() || `column ${i + 1}`;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count) name = `${name} ${count + 1}`;
    return name;
  });
}

function rowsToObjects(rows: string[][]): Record<string, Cell>[] {
  if (!rows.length) return [];
  const head = headerNames(rows[0]);
  return rows.slice(1).map((r) => {
    const o: Record<string, Cell> = {};
    head.forEach((h, i) => {
      o[h] = typed(r[i] ?? '');
    });
    return o;
  });
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Rows from parsed JSON: an array of objects or arrays, a single object, or an object holding one array. */
function jsonToRows(value: unknown): string[][] {
  let list: unknown = value;
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    const arrays = Object.values(list).filter(Array.isArray);
    list = arrays.length === 1 ? arrays[0] : [list];
  }
  if (!Array.isArray(list)) list = [list];
  const items = list as unknown[];
  if (items.every((x) => Array.isArray(x))) return (items as unknown[][]).map((r) => r.map(cellText));
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (it && typeof it === 'object' && !Array.isArray(it)) {
      for (const k of Object.keys(it)) {
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
      }
    }
  }
  if (!keys.length) return [['value'], ...items.map((x) => [cellText(x)])];
  return [
    keys,
    ...items.map((it) =>
      keys.map((k) => (it && typeof it === 'object' ? cellText((it as Record<string, unknown>)[k]) : '')),
    ),
  ];
}

function writeDelimited(rows: string[][], sep: string): string {
  const needs = new RegExp(`["\\r\\n${sep === '\t' ? '\\t' : sep}]|^\\s|\\s$`);
  return rows.map((r) => r.map((v) => (needs.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(sep)).join('\n') + '\n';
}

const SEP: Record<string, string> = { CSV: ',', TSV: '\t' };
const MIME: Record<string, string> = { CSV: 'text/csv', TSV: 'text/tab-separated-values', JSON: 'application/json' };

export async function convertData(file: File, from: string, to: string): Promise<Blob> {
  const text = (await file.text()).replace(/^\uFEFF/, '');
  let rows: string[][];
  if (from === 'JSON') {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('This JSON doesn’t parse. Check for a missing comma or quote.');
    }
    rows = jsonToRows(value);
  } else {
    // a .csv saved with semicolons or tabs still reads
    let sep = SEP[from];
    if (from === 'CSV') {
      const nl = text.search(/\r?\n/);
      const first = nl < 0 ? text : text.slice(0, nl);
      const counts = [',', ';', '\t'].map((s) => [s, first.split(s).length] as const).sort((a, b) => b[1] - a[1]);
      if (counts[0][1] > 1) sep = counts[0][0];
    }
    rows = parseDelimited(text, sep);
  }
  let out: string;
  if (to === 'JSON') {
    out = JSON.stringify(rowsToObjects(rows), null, 2) + '\n';
  } else {
    out = writeDelimited(rows, SEP[to]);
  }
  return new Blob([out], { type: `${MIME[to]};charset=utf-8` });
}

/** How many rows a table holds, for the note beside it. */
export function countRows(blob: Blob, fmt: string): Promise<number> {
  return blob.text().then((t) => {
    if (fmt === 'JSON') {
      try {
        const v = JSON.parse(t);
        return Array.isArray(v) ? v.length : 1;
      } catch {
        return 0;
      }
    }
    return Math.max(0, parseDelimited(t.replace(/^\uFEFF/, ''), SEP[fmt]).length - 1);
  });
}
