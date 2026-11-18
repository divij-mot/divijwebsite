/* Images: decode anything the browser or a small decoder can read, then write it out. */

export interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** vector sources can be drawn at any size */
  vector?: boolean;
  dispose(): void;
}

export function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement) {
  const ctx = c.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('This browser couldn’t open a drawing surface.');
  return ctx;
}

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = url;
  });
}

async function nativeDecode(blob: Blob): Promise<Decoded> {
  try {
    const bmp = await createImageBitmap(blob);
    return { source: bmp, width: bmp.width, height: bmp.height, dispose: () => bmp.close() };
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImg(url);
      if (!img.naturalWidth) throw new Error('decode');
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, dispose: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }
}

async function decodeSVG(file: File): Promise<Decoded> {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') throw new Error('decode');
  const num = (v: string | null) => {
    if (!v || /%$/.test(v.trim())) return 0;
    const n = parseFloat(v);
    return isFinite(n) && n > 0 ? n : 0;
  };
  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 && vb[2] > 0 ? vb[2] : 0;
  const vbH = vb.length === 4 && vb[3] > 0 ? vb[3] : 0;
  let w = num(svg.getAttribute('width'));
  let h = num(svg.getAttribute('height'));
  if (!w && !h) {
    w = vbW || 1024;
    h = vbH || (vbW ? vbW : 1024);
  } else if (!w) {
    w = vbW && vbH ? (h * vbW) / vbH : h;
  } else if (!h) {
    h = vbW && vbH ? (w * vbH) / vbW : w;
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  // fix the size on the root so every browser rasterises it the same way
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  if (!svg.getAttribute('viewBox') && !vbW) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImg(url);
    return { source: img, width: w, height: h, vector: true, dispose: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

async function decodeTIFF(file: File): Promise<Decoded> {
  const UTIF = await import('utif');
  const buf = await file.arrayBuffer();
  const ifds = UTIF.decode(buf);
  if (!ifds.length) throw new Error('decode');
  // the largest colour image in the file: DNGs keep a full size preview beside the raw data
  let pages = ifds;
  if (ifds[0].subIFD) pages = pages.concat(ifds[0].subIFD);
  let page = ifds[0];
  let best = 0;
  for (const p of pages) {
    const bps = p.t258 as number[] | undefined;
    if (!bps || bps.length < 3) continue;
    const w = (p.t256 as number[] | undefined)?.[0] ?? 0;
    const h = (p.t257 as number[] | undefined)?.[0] ?? 0;
    if (w * h > best) {
      best = w * h;
      page = p;
    }
  }
  UTIF.decodeImage(buf, page, ifds);
  const rgba = UTIF.toRGBA8(page);
  const { width, height } = page;
  if (!width || !height || rgba.length < width * height * 4) throw new Error('decode');
  const c = makeCanvas(width, height);
  ctx2d(c).putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4), width, height), 0, 0);
  return { source: c, width, height, dispose: () => { c.width = c.height = 0; } };
}

// libheif runs in a worker of its own; it starts with the first HEIC and stays for the rest
let heicWorker: Worker | null = null;
let heicSeq = 0;
const heicJobs = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>();

function heicInWorker(blob: Blob): Promise<ImageBitmap> {
  if (!heicWorker) {
    heicWorker = new Worker(new URL('./heic.worker.ts', import.meta.url), { type: 'module' });
    heicWorker.onmessage = (e: MessageEvent<{ id: number; bitmap?: ImageBitmap; error?: string }>) => {
      const job = heicJobs.get(e.data.id);
      heicJobs.delete(e.data.id);
      if (!job) return;
      if (e.data.bitmap) job.resolve(e.data.bitmap);
      else job.reject(new Error('decode'));
    };
    heicWorker.onerror = () => {
      heicJobs.forEach((j) => j.reject(new Error('decode')));
      heicJobs.clear();
      heicWorker?.terminate();
      heicWorker = null;
    };
  }
  const id = ++heicSeq;
  return new Promise((resolve, reject) => {
    heicJobs.set(id, { resolve, reject });
    heicWorker!.postMessage({ id, blob });
  });
}

/** Free the decoder workers when the page goes. */
export function disposeImageWorkers() {
  heicWorker?.terminate();
  heicWorker = null;
  heicJobs.forEach((j) => j.reject(new Error('decode')));
  heicJobs.clear();
}

async function decodeHEIC(file: File): Promise<Decoded> {
  try {
    return await nativeDecode(file); // Safari reads HEIC itself
  } catch {
    const bmp = await heicInWorker(file);
    return { source: bmp, width: bmp.width, height: bmp.height, dispose: () => bmp.close() };
  }
}

export async function decodeImage(file: File, fmt: string): Promise<Decoded> {
  try {
    if (fmt === 'SVG') return await decodeSVG(file);
    if (fmt === 'HEIC') return await decodeHEIC(file);
    if (fmt === 'TIFF' || fmt === 'DNG') {
      try {
        return await nativeDecode(file);
      } catch {
        return await decodeTIFF(file);
      }
    }
    return await nativeDecode(file);
  } catch (e) {
    if (e instanceof Error && e.message !== 'decode' && !/decod|source|state/i.test(e.message)) throw e;
    throw new Error(
      fmt === 'AVIF'
        ? 'This browser can’t read AVIF images.'
        : `Couldn’t read this ${fmt === 'JPG' ? 'JPG' : fmt}. It may be damaged.`,
    );
  }
}

/** Draw a decoded image at most `maxEdge` on its long side (0 keeps the size); vectors scale to it. */
export function render(dec: Decoded, maxEdge: number, flatten: boolean): HTMLCanvasElement {
  let scale = 1;
  if (maxEdge > 0) {
    const s = maxEdge / Math.max(dec.width, dec.height);
    scale = dec.vector ? s : Math.min(1, s);
  }
  const tw = Math.max(1, Math.round(dec.width * scale));
  const th = Math.max(1, Math.round(dec.height * scale));

  // large reductions go down in halves, which keeps fine detail from aliasing
  let src: CanvasImageSource = dec.source;
  let sw = dec.width;
  let sh = dec.height;
  const temps: HTMLCanvasElement[] = [];
  while (!dec.vector && sw / 2 > tw && sh / 2 > th) {
    const nw = Math.max(tw, Math.round(sw / 2));
    const nh = Math.max(th, Math.round(sh / 2));
    const step = makeCanvas(nw, nh);
    const sctx = ctx2d(step);
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(src, 0, 0, sw, sh, 0, 0, nw, nh);
    temps.push(step);
    src = step;
    sw = nw;
    sh = nh;
  }

  const out = makeCanvas(tw, th);
  const ctx = ctx2d(out);
  if (flatten) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, tw, th);
  }
  ctx.imageSmoothingQuality = 'high';
  if (dec.vector) ctx.drawImage(src, 0, 0, tw, th);
  else ctx.drawImage(src, 0, 0, sw, sh, 0, 0, tw, th);
  for (const t of temps) t.width = t.height = 0;
  return out;
}

export function toBlob(c: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('This image is too large for this browser to write.'))),
      mime,
      quality,
    ),
  );
}

/** Whether canvas can write this type (unsupported types quietly come back as PNG). */
export async function canvasWrites(mime: string): Promise<boolean> {
  try {
    const c = makeCanvas(2, 2);
    ctx2d(c).fillRect(0, 0, 1, 1);
    const b = await toBlob(c, mime, 0.8);
    return b.type === mime;
  } catch {
    return false;
  }
}

function pixels(c: HTMLCanvasElement) {
  return ctx2d(c).getImageData(0, 0, c.width, c.height);
}

function encodeBMP(c: HTMLCanvasElement): Blob {
  const { width: w, height: h, data } = pixels(c);
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  v.setUint16(0, 0x424d);
  v.setUint32(2, size, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, row * h, true);
  v.setInt32(38, 2835, true);
  v.setInt32(42, 2835, true);
  const out = new Uint8Array(buf);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * row;
    let i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4, o += 3) {
      out[o] = data[i + 2];
      out[o + 1] = data[i + 1];
      out[o + 2] = data[i];
    }
  }
  return new Blob([buf], { type: 'image/bmp' });
}

async function encodeTIFF(c: HTMLCanvasElement): Promise<Blob> {
  const UTIF = await import('utif');
  const { width, height, data } = pixels(c);
  // 338 = ExtraSamples; 2 marks the alpha as unassociated, which is what canvas hands back
  const buf = UTIF.encodeImage(data.buffer as ArrayBuffer, width, height, { t338: [2], t305: ['File Converter'] });
  return new Blob([buf], { type: 'image/tiff' });
}

async function encodeGIF(c: HTMLCanvasElement): Promise<Blob> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const { width, height, data } = pixels(c);
  let alpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 128) {
      alpha = true;
      break;
    }
  }
  const format = alpha ? 'rgba4444' : 'rgb565';
  const palette = quantize(data, 256, { format, oneBitAlpha: alpha });
  const index = applyPalette(data, palette, format);
  const t = alpha ? palette.findIndex((p) => p[3] === 0) : -1;
  const gif = GIFEncoder();
  gif.writeFrame(index, width, height, { palette, transparent: t >= 0, transparentIndex: Math.max(0, t) });
  gif.finish();
  return new Blob([gif.bytes() as BlobPart], { type: 'image/gif' });
}

/** An icon file holding the usual sizes, each a PNG. */
async function encodeICO(dec: Decoded): Promise<Blob> {
  const long = Math.max(dec.width, dec.height);
  let sizes = [16, 24, 32, 48, 64, 128, 256].filter((s) => dec.vector || s <= long);
  if (!sizes.length) sizes = [16];
  const pngs: Uint8Array[] = [];
  for (const s of sizes) {
    const fit = render(dec, s, false);
    const sq = makeCanvas(s, s);
    const ctx = ctx2d(sq);
    ctx.drawImage(fit, Math.round((s - fit.width) / 2), Math.round((s - fit.height) / 2));
    pngs.push(new Uint8Array(await (await toBlob(sq, 'image/png')).arrayBuffer()));
  }
  const head = 6 + 16 * sizes.length;
  const total = head + pngs.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, sizes.length, true);
  let offset = head;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    out[e] = s >= 256 ? 0 : s;
    out[e + 1] = s >= 256 ? 0 : s;
    v.setUint16(e + 4, 1, true);
    v.setUint16(e + 6, 32, true);
    v.setUint32(e + 8, pngs[i].length, true);
    v.setUint32(e + 12, offset, true);
    out.set(pngs[i], offset);
    offset += pngs[i].length;
  });
  return new Blob([out], { type: 'image/x-icon' });
}

export interface ImageOptions {
  quality: number; // 1..100
  maxEdge: number; // 0 = original
  canWebp: boolean;
}

/** Image to image. PDF output is handled with the other PDF work. */
export async function convertImage(
  file: File,
  fmt: string,
  target: string,
  o: ImageOptions,
  progress: (p: number) => void,
): Promise<Blob> {
  const dec = await decodeImage(file, fmt);
  progress(0.45);
  try {
    if (target === 'ICO') return await encodeICO(dec);
    const canvas = render(dec, o.maxEdge, target === 'JPG' || target === 'BMP');
    progress(0.7);
    const q = Math.min(1, Math.max(0.01, o.quality / 100));
    try {
      switch (target) {
        case 'JPG':
          return await toBlob(canvas, 'image/jpeg', q);
        case 'PNG':
          return await toBlob(canvas, 'image/png');
        case 'AVIF':
          return await toBlob(canvas, 'image/avif', q);
        case 'WEBP':
          if (o.canWebp) return await toBlob(canvas, 'image/webp', q);
          // Safari can’t write WEBP from a canvas: hand a PNG to the media engine instead
          return await (await import('./media')).pngToWebp(await toBlob(canvas, 'image/png'), o.quality);
        case 'BMP':
          return encodeBMP(canvas);
        case 'TIFF':
          return await encodeTIFF(canvas);
        case 'GIF':
          return await encodeGIF(canvas);
      }
      throw new Error(`Can’t write ${target} here.`);
    } finally {
      canvas.width = canvas.height = 0;
    }
  } finally {
    dec.dispose();
  }
}

/** The EXIF orientation of a JPEG (1 when upright or unknown). */
export async function jpegOrientation(blob: Blob): Promise<number> {
  try {
    const v = new DataView(await blob.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return 1;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
        const tiff = off + 10;
        const le = v.getUint16(tiff) === 0x4949;
        const ifd = tiff + v.getUint32(tiff + 4, le);
        const n = v.getUint16(ifd, le);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le);
        }
        return 1;
      }
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return 1;
      off += 2 + len;
    }
  } catch {
    /* unreadable header: treat as upright */
  }
  return 1;
}

/** An image ready to place in a PDF: JPEG or PNG bytes and its pixel size. */
export interface PdfImage {
  bytes: Uint8Array;
  type: 'jpg' | 'png';
  width: number;
  height: number;
}

export async function imageForPdf(file: File, fmt: string, o: ImageOptions): Promise<PdfImage> {
  // keep the original bytes when nothing needs to change: no recompression
  if (!o.maxEdge && (fmt === 'JPG' || fmt === 'PNG') && (fmt === 'PNG' || (await jpegOrientation(file)) <= 1)) {
    const dec = await nativeDecode(file).catch(() => null);
    if (dec) {
      const { width, height } = dec;
      dec.dispose();
      return { bytes: new Uint8Array(await file.arrayBuffer()), type: fmt === 'JPG' ? 'jpg' : 'png', width, height };
    }
  }
  const dec = await decodeImage(file, fmt);
  try {
    const probe = render(dec, o.maxEdge, false);
    const { data } = pixels(probe);
    let alpha = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) {
        alpha = true;
        break;
      }
    }
    let blob: Blob;
    if (alpha) blob = await toBlob(probe, 'image/png');
    else blob = await toBlob(probe, 'image/jpeg', Math.min(1, Math.max(0.01, o.quality / 100)));
    const out = { bytes: new Uint8Array(await blob.arrayBuffer()), type: alpha ? 'png' : 'jpg', width: probe.width, height: probe.height } as PdfImage;
    probe.width = probe.height = 0;
    return out;
  } finally {
    dec.dispose();
  }
}
