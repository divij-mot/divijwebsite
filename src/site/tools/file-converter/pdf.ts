/* PDFs: pages out as images (pdf.js), images and PDFs in as one document (pdf-lib). */
import type { PdfImage } from './image';
import { makeCanvas, toBlob } from './image';

type PdfJs = typeof import('pdfjs-dist');

// fonts, CMaps and decoders pdf.js asks for by name; each file is fetched only if a document needs it
const glob = (files: Record<string, string>) => files;
const BIN: Record<string, Record<string, string>> = {
  cMapUrl: glob(import.meta.glob('/node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url', import: 'default', eager: true })),
  standardFontDataUrl: glob(
    import.meta.glob('/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { query: '?url', import: 'default', eager: true }),
  ),
  wasmUrl: glob(
    import.meta.glob('/node_modules/pdfjs-dist/wasm/{openjpeg,jbig2,qcms_bg}.wasm', { query: '?url', import: 'default', eager: true }),
  ),
};

class BinaryData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const table = BIN[kind] ?? {};
    const key = Object.keys(table).find((k) => k.endsWith(`/${filename}`));
    if (!key) throw new Error(`Missing ${filename}`);
    const res = await fetch(table[key]);
    if (!res.ok) throw new Error(`Missing ${filename}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

let pdfjsP: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> {
  return (pdfjsP ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
    ([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    },
  ));
}

async function open(file: Blob) {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    BinaryDataFactory: BinaryData,
    useWorkerFetch: false,
    cMapPacked: true,
  });
  try {
    return await task.promise;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'PasswordException') throw new Error('This PDF is locked with a password.');
    throw new Error('Couldn’t read this PDF. It may be damaged.');
  }
}

/** Page count and a small picture of the first page. */
export async function pdfPreview(file: File): Promise<{ pages: number; thumb: Blob | null }> {
  const doc = await open(file);
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 360 / Math.max(base.width, base.height) });
    const canvas = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const thumb = await toBlob(canvas, 'image/jpeg', 0.8).catch(() => null);
    canvas.width = canvas.height = 0;
    return { pages: doc.numPages, thumb };
  } finally {
    doc.destroy();
  }
}

export interface PageImages {
  quality: number;
  maxEdge: number; // 0 = about 144 dpi
}

/** Every page of a PDF as an image. */
export async function pdfToImages(
  file: File,
  target: 'PNG' | 'JPG' | 'WEBP',
  o: PageImages,
  progress: (p: number) => void,
  signal: AbortSignal,
): Promise<Blob[]> {
  const doc = await open(file);
  const mime = target === 'PNG' ? 'image/png' : target === 'JPG' ? 'image/jpeg' : 'image/webp';
  const out: Blob[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = o.maxEdge ? o.maxEdge / Math.max(base.width, base.height) : 2;
      const viewport = page.getViewport({ scale });
      const canvas = makeCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      out.push(await toBlob(canvas, mime, target === 'PNG' ? undefined : o.quality / 100));
      canvas.width = canvas.height = 0;
      page.cleanup();
      progress(i / doc.numPages);
    }
  } finally {
    doc.destroy();
  }
  return out;
}

export type PdfPart = { kind: 'image'; image: PdfImage } | { kind: 'pdf'; bytes: Uint8Array };

// pages keep the picture’s proportions; big pictures sit on a page no longer than A4, at full resolution
const A4_LONG = 842;

/** One PDF from images and other PDFs, in order. */
export async function buildPdf(parts: PdfPart[], progress: (p: number) => void): Promise<{ blob: Blob; pages: number }> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.kind === 'image') {
      const { image } = part;
      const embedded = image.type === 'jpg' ? await doc.embedJpg(image.bytes) : await doc.embedPng(image.bytes);
      const s = Math.min(1, A4_LONG / Math.max(image.width, image.height));
      const w = image.width * s;
      const h = image.height * s;
      doc.addPage([w, h]).drawImage(embedded, { x: 0, y: 0, width: w, height: h });
    } else {
      let src;
      try {
        src = await PDFDocument.load(part.bytes, { ignoreEncryption: true });
      } catch {
        throw new Error('One of the PDFs couldn’t be read.');
      }
      const pages = await doc.copyPages(src, src.getPageIndices());
      pages.forEach((p) => doc.addPage(p));
    }
    progress((i + 1) / parts.length);
  }
  const bytes = await doc.save();
  return { blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }), pages: doc.getPageCount() };
}
