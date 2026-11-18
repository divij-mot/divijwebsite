/* What the converter reads, what it writes, and which way each file goes by default. */

export type Family = 'image' | 'video' | 'audio' | 'pdf' | 'data';

export interface Format {
  id: string;
  ext: string;
  mime: string;
  family: Family;
}

const f = (id: string, ext: string, mime: string, family: Family): Format => ({ id, ext, mime, family });

export const FORMATS: Record<string, Format> = Object.fromEntries(
  [
    f('JPG', 'jpg', 'image/jpeg', 'image'),
    f('PNG', 'png', 'image/png', 'image'),
    f('WEBP', 'webp', 'image/webp', 'image'),
    f('AVIF', 'avif', 'image/avif', 'image'),
    f('HEIC', 'heic', 'image/heic', 'image'),
    f('GIF', 'gif', 'image/gif', 'image'),
    f('BMP', 'bmp', 'image/bmp', 'image'),
    f('TIFF', 'tiff', 'image/tiff', 'image'),
    f('DNG', 'dng', 'image/x-adobe-dng', 'image'),
    f('ICO', 'ico', 'image/x-icon', 'image'),
    f('SVG', 'svg', 'image/svg+xml', 'image'),

    f('MP4', 'mp4', 'video/mp4', 'video'),
    f('MOV', 'mov', 'video/quicktime', 'video'),
    f('WEBM', 'webm', 'video/webm', 'video'),
    f('MKV', 'mkv', 'video/x-matroska', 'video'),
    f('AVI', 'avi', 'video/x-msvideo', 'video'),
    f('M4V', 'm4v', 'video/x-m4v', 'video'),
    f('3GP', '3gp', 'video/3gpp', 'video'),
    f('OGV', 'ogv', 'video/ogg', 'video'),
    f('TS', 'ts', 'video/mp2t', 'video'),
    f('MPG', 'mpg', 'video/mpeg', 'video'),
    f('FLV', 'flv', 'video/x-flv', 'video'),
    f('WMV', 'wmv', 'video/x-ms-wmv', 'video'),

    f('MP3', 'mp3', 'audio/mpeg', 'audio'),
    f('WAV', 'wav', 'audio/wav', 'audio'),
    f('AAC', 'aac', 'audio/aac', 'audio'),
    f('M4A', 'm4a', 'audio/mp4', 'audio'),
    f('FLAC', 'flac', 'audio/flac', 'audio'),
    f('OGG', 'ogg', 'audio/ogg', 'audio'),
    f('OPUS', 'opus', 'audio/ogg', 'audio'),
    f('AIFF', 'aiff', 'audio/aiff', 'audio'),
    f('WMA', 'wma', 'audio/x-ms-wma', 'audio'),

    f('PDF', 'pdf', 'application/pdf', 'pdf'),

    f('CSV', 'csv', 'text/csv', 'data'),
    f('TSV', 'tsv', 'text/tab-separated-values', 'data'),
    f('JSON', 'json', 'application/json', 'data'),
  ].map((x) => [x.id, x]),
);

const ALIASES: Record<string, string> = {
  jpeg: 'JPG', jpe: 'JPG', jfif: 'JPG', pjpeg: 'JPG',
  tif: 'TIFF',
  heif: 'HEIC', hif: 'HEIC',
  aif: 'AIFF', aifc: 'AIFF',
  mpeg: 'MPG', mpe: 'MPG', m2v: 'MPG', vob: 'MPG',
  mts: 'TS', m2ts: 'TS',
  qt: 'MOV',
  '3g2': '3GP',
  oga: 'OGG',
  m4b: 'M4A',
  weba: 'WEBM',
};

const MIMES: Record<string, string> = {
  'image/jpg': 'JPG', 'image/x-png': 'PNG', 'image/heif': 'HEIC', 'image/vnd.microsoft.icon': 'ICO',
  'audio/mp3': 'MP3', 'audio/x-wav': 'WAV', 'audio/wave': 'WAV', 'audio/x-m4a': 'M4A', 'audio/x-flac': 'FLAC',
  'audio/x-aiff': 'AIFF', 'audio/webm': 'WEBM', 'audio/opus': 'OPUS',
  'application/x-pdf': 'PDF',
};

/** The format of a file, from its extension, then its type. */
export function detect(file: File): Format | null {
  const ext = (file.name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
  const byExt = FORMATS[ext.toUpperCase()] ?? FORMATS[ALIASES[ext] ?? ''];
  if (byExt) return byExt;
  const type = file.type.toLowerCase();
  if (!type) return null;
  const byMime = Object.values(FORMATS).find((x) => x.mime === type) ?? FORMATS[MIMES[type] ?? ''];
  return byMime ?? null;
}

export interface Caps {
  webp: boolean; // canvas can write WEBP
  avif: boolean; // canvas can write AVIF
}

/** Output choices for an input, in groups; `more` holds the long tail, revealed on request. */
export interface Choices {
  groups: string[][];
  more: string[][];
}

const imageOuts = (caps: Caps) =>
  ['JPG', 'PNG', 'WEBP', caps.avif ? 'AVIF' : '', 'GIF', 'BMP', 'TIFF', 'ICO', 'PDF'].filter(Boolean);

export function choicesFor(input: Format, caps: Caps): Choices {
  switch (input.family) {
    case 'image':
      if (input.id === 'GIF') {
        return { groups: [imageOuts(caps).filter((x) => x !== 'GIF'), ['MP4', 'WEBM']], more: [] };
      }
      return { groups: [imageOuts(caps)], more: [] };
    case 'video':
      return {
        groups: [
          ['MP4', 'WEBM', 'MOV', 'MKV', 'AVI', 'GIF'],
          ['MP3', 'M4A', 'WAV', 'FLAC', 'OGG', 'OPUS'],
        ],
        more: [
          ['M4V', '3GP', 'OGV', 'TS', 'MPG', 'FLV', 'WMV'],
          ['AAC', 'AIFF', 'WMA'],
        ],
      };
    case 'audio':
      return { groups: [['MP3', 'M4A', 'WAV', 'FLAC', 'OGG', 'OPUS', 'AAC', 'AIFF', 'WMA']], more: [] };
    case 'pdf':
      return { groups: [['PNG', 'JPG', caps.webp ? 'WEBP' : ''].filter(Boolean)], more: [] };
    case 'data':
      return { groups: [['CSV', 'TSV', 'JSON'].filter((x) => x !== input.id)], more: [] };
  }
}

export const allChoices = (c: Choices) => [...c.groups.flat(), ...c.more.flat()];

const DEFAULTS: Record<string, string> = {
  JPG: 'PNG', PNG: 'JPG', WEBP: 'JPG', AVIF: 'JPG', HEIC: 'JPG', TIFF: 'JPG', DNG: 'JPG',
  BMP: 'PNG', ICO: 'PNG', SVG: 'PNG', GIF: 'MP4',
  MP4: 'MP3', MOV: 'MP4', WEBM: 'MP4', MKV: 'MP4', AVI: 'MP4', M4V: 'MP4', '3GP': 'MP4',
  OGV: 'MP4', TS: 'MP4', MPG: 'MP4', FLV: 'MP4', WMV: 'MP4',
  MP3: 'WAV', WAV: 'MP3', AAC: 'MP3', M4A: 'MP3', FLAC: 'MP3', OGG: 'MP3', OPUS: 'MP3', AIFF: 'MP3', WMA: 'MP3',
  PDF: 'PNG',
  CSV: 'JSON', TSV: 'CSV', JSON: 'CSV',
};

export function defaultTarget(input: Format, caps: Caps): string {
  const options = allChoices(choicesFor(input, caps));
  const d = DEFAULTS[input.id];
  return d && options.includes(d) ? d : options[0];
}

/** Which way a conversion runs: the engine it needs. */
export type Route = 'image' | 'media' | 'pdf' | 'data';

export function routeOf(input: Format, target: string): Route {
  const out = FORMATS[target];
  if (input.family === 'data') return 'data';
  if (input.family === 'pdf') return 'pdf';
  if (input.family === 'image') return out.family === 'video' ? 'media' : 'image';
  return 'media';
}

export const LOSSY_AUDIO = new Set(['MP3', 'AAC', 'M4A', 'OGG', 'OPUS', 'WMA']);
export const H26X = new Set(['MP4', 'MOV', 'M4V', 'MKV']);

export type SettingKey = 'quality' | 'imageSize' | 'videoSize' | 'codec' | 'vpx' | 'targetMB' | 'bitrate' | 'gif';

/** The settings that change the result of converting `input` to `target`. */
export function settingsFor(input: Format, target: string): SettingKey[] {
  const route = routeOf(input, target);
  if (route === 'data') return [];
  if (route === 'image') {
    if (target === 'ICO') return [];
    if (['JPG', 'WEBP', 'AVIF', 'PDF'].includes(target)) return ['quality', 'imageSize'];
    return ['imageSize'];
  }
  if (route === 'pdf') return target === 'PNG' ? ['imageSize'] : ['quality', 'imageSize'];
  // media
  const out = FORMATS[target];
  if (out.family === 'audio') return LOSSY_AUDIO.has(target) ? ['bitrate'] : [];
  if (target === 'GIF') return ['gif'];
  const keys: SettingKey[] = ['quality', 'videoSize'];
  if (H26X.has(target)) keys.push('codec');
  if (target === 'WEBM') keys.push('vpx');
  if (input.family === 'video') keys.push('targetMB');
  return keys;
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}

export function formatDuration(s: number): string {
  if (!isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

export const baseName = (name: string) => name.replace(/\.[^.]+$/, '') || name;
