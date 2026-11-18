/* One entry point for every conversion, plus the zip and PDF work that spans files. */
import { FORMATS, baseName, routeOf, settingsFor, type Caps, type Format } from './formats';
import type { MediaPhase, MediaSettings } from './media';

export interface Settings extends MediaSettings {
  imageSize: number; // long side cap for images and PDF pages, 0 = original
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 80,
  imageSize: 0,
  videoSize: 0,
  codec: 'h264',
  vpx: 'vp8',
  targetMB: null,
  bitrate: 192,
  gifWidth: 480,
  gifFps: 15,
};

export interface Output {
  name: string;
  blob: Blob;
}

export type Phase = MediaPhase;

/** The parts of the settings that shape this file’s result. */
export function recipeKey(fmt: Format, target: string, s: Settings): string {
  const parts = settingsFor(fmt, target).map((k) => (k === 'gif' ? `${s.gifWidth}/${s.gifFps}` : String(s[k])));
  return [target, ...parts].join('|');
}

const abortError = () => new DOMException('Stopped', 'AbortError');

export async function convert(
  file: File,
  fmt: Format,
  target: string,
  s: Settings,
  caps: Caps,
  progress: (phase: Phase, p: number) => void,
  signal: AbortSignal,
): Promise<Output[]> {
  const out = FORMATS[target];
  const base = baseName(file.name);
  const name = `${base}.${out.ext}`;
  const route = routeOf(fmt, target);

  if (route === 'data') {
    const { convertData } = await import('./data');
    return [{ name, blob: await convertData(file, fmt.id, target) }];
  }

  if (route === 'image') {
    progress('converting', 0.1);
    const opts = { quality: s.quality, maxEdge: s.imageSize, canWebp: caps.webp };
    if (target === 'PDF') {
      const [{ imageForPdf }, { buildPdf }] = await Promise.all([import('./image'), import('./pdf')]);
      const image = await imageForPdf(file, fmt.id, opts);
      progress('converting', 0.6);
      if (signal.aborted) throw abortError();
      return [{ name, blob: (await buildPdf([{ kind: 'image', image }], () => undefined)).blob }];
    }
    const { convertImage } = await import('./image');
    const blob = await convertImage(file, fmt.id, target, opts, (p) => progress('converting', p));
    if (signal.aborted) throw abortError();
    return [{ name, blob }];
  }

  if (route === 'pdf') {
    const { pdfToImages } = await import('./pdf');
    const pages = await pdfToImages(
      file,
      target as 'PNG' | 'JPG' | 'WEBP',
      { quality: s.quality, maxEdge: s.imageSize },
      (p) => progress('converting', p),
      signal,
    );
    if (pages.length === 1) return [{ name, blob: pages[0] }];
    const pad = String(pages.length).length;
    return pages.map((blob, i) => ({ name: `${base}-${String(i + 1).padStart(pad, '0')}.${out.ext}`, blob }));
  }

  const { convertMedia } = await import('./media');
  const blob = await convertMedia(file, fmt.id, target, s, progress, signal);
  return [{ name, blob }];
}

/** Images and PDFs, in list order, as one PDF. */
export async function combineToPdf(
  files: { file: File; fmt: Format }[],
  s: Settings,
  progress: (p: number) => void,
): Promise<{ blob: Blob; pages: number }> {
  const [{ imageForPdf }, { buildPdf }] = await Promise.all([import('./image'), import('./pdf')]);
  const parts: import('./pdf').PdfPart[] = [];
  for (let i = 0; i < files.length; i++) {
    const { file, fmt } = files[i];
    if (fmt.family === 'pdf') parts.push({ kind: 'pdf', bytes: new Uint8Array(await file.arrayBuffer()) });
    else parts.push({ kind: 'image', image: await imageForPdf(file, fmt.id, { quality: s.quality, maxEdge: s.imageSize, canWebp: false }) });
    progress(((i + 1) / files.length) * 0.7);
  }
  return buildPdf(parts, (p) => progress(0.7 + p * 0.3));
}

const STORED = /\.(jpe?g|png|webp|avif|gif|heic|mp4|mov|webm|mkv|avi|m4v|3gp|ogv|ts|mpg|flv|wmv|mp3|aac|m4a|flac|ogg|opus|wma|zip|pdf)$/i;

/** Files into one zip; folders where a file brought several outputs. */
export async function zipFiles(entries: { path: string; blob: Blob }[]): Promise<Blob> {
  const { zip } = await import('fflate');
  const used = new Set<string>();
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const { path, blob } of entries) {
    let p = path;
    for (let n = 2; used.has(p.toLowerCase()); n++) p = path.replace(/(\.[^./]+)?$/, ` ${n}$1`);
    used.add(p.toLowerCase());
    files[p] = [new Uint8Array(await blob.arrayBuffer()), { level: STORED.test(p) ? 0 : 6 }];
  }
  return new Promise((resolve, reject) =>
    zip(files, (err, data) => (err ? reject(err) : resolve(new Blob([data as BlobPart], { type: 'application/zip' })))),
  );
}
