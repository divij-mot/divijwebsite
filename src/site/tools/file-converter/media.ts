/* Video and audio, through ffmpeg.wasm. The engine loads only when a conversion needs it:
   multi-threaded when the page is cross-origin isolated, single-threaded otherwise. */
import type { FFmpeg, LogEvent, ProgressEvent } from '@ffmpeg/ffmpeg';
import { FORMATS } from './formats';

export interface MediaSettings {
  quality: number; // 1..100
  videoSize: number; // short side cap, 0 = original
  codec: 'h264' | 'h265';
  vpx: 'vp8' | 'vp9';
  targetMB: number | null;
  bitrate: number; // kbps, lossy audio
  gifWidth: number;
  gifFps: number;
}

export const DEFAULT_QUALITY = 80;

interface Engine {
  ff: FFmpeg;
  mt: boolean;
}

/** Shared memory is there, so the multi-threaded core can run. */
export const isolated = () =>
  typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';

let engineP: Promise<Engine> | null = null;
let live: Engine | null = null;
const wasmCache = new Map<string, Promise<string>>();
const loadWatchers = new Set<(p: number) => void>();

function fetchWasm(url: string): Promise<string> {
  let p = wasmCache.get(url);
  if (!p) {
    p = (async () => {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error('The converter didn’t load. Check the connection and try again.');
      const total = Number(res.headers.get('content-length')) || 32e6;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        const p = Math.min(0.98, got / total);
        loadWatchers.forEach((w) => w(p));
      }
      return URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'application/wasm' }));
    })();
    p.catch(() => wasmCache.delete(url));
    wasmCache.set(url, p);
  }
  return p;
}

async function boot(mt: boolean): Promise<Engine> {
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  const base = new URL(mt ? '/ffmpeg-mt/' : '/ffmpeg-st/', location.href).href;
  const wasmURL = await fetchWasm(`${base}ffmpeg-core.wasm`);
  const ff = new FFmpeg();
  await ff.load({
    coreURL: `${base}ffmpeg-core.js`,
    wasmURL,
    ...(mt ? { workerURL: `${base}ffmpeg-core.worker.js` } : {}),
  });
  return { ff, mt };
}

function engine(onLoad?: (p: number) => void): Promise<Engine> {
  if (onLoad) loadWatchers.add(onLoad);
  if (!engineP) {
    const p = (async () => {
      if (isolated()) {
        try {
          return await boot(true);
        } catch {
          /* the single-threaded core below always works */
        }
      }
      return boot(false);
    })();
    engineP = p;
    p.then(
      (e) => {
        if (engineP === p) live = e;
      },
      () => {
        if (engineP === p) engineP = null;
      },
    );
  }
  const p = engineP;
  return p.finally(() => {
    if (onLoad) loadWatchers.delete(onLoad);
  });
}

/** Kill whatever is running; the next conversion starts a fresh engine. */
export function stopEngine() {
  const e = live;
  engineP = null;
  live = null;
  e?.ff.terminate();
}

export const engineKind = () => (live ? (live.mt ? 'multi-threaded' : 'single-threaded') : null);

// one job at a time inside the engine
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

let seq = 0;

interface Probe {
  duration: number;
  video?: { codec: string; w: number; h: number; fps: number };
  audio?: { codec: string };
}

function parseProbe(text: string): Probe {
  const p: Probe = { duration: 0 };
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) p.duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
  for (const line of text.split('\n')) {
    const v = /Stream #\d+:\d+.*?: Video: (\w+)(.*)$/.exec(line);
    if (v && !p.video && !/attached pic/.test(line)) {
      const dims = /,\s*(\d{2,5})x(\d{2,5})[\s,]/.exec(v[2]);
      const fps = /([\d.]+) fps/.exec(v[2]) ?? /([\d.]+) tbr/.exec(v[2]);
      p.video = { codec: v[1], w: dims ? +dims[1] : 0, h: dims ? +dims[2] : 0, fps: fps ? +fps[1] : 0 };
    }
    const a = /Stream #\d+:\d+.*?: Audio: (\w+)/.exec(line);
    if (a && !p.audio) p.audio = { codec: a[1] };
  }
  return p;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function audioArgs(target: string, kbps: number): string[] {
  switch (target) {
    case 'MP3':
      return ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`];
    case 'AAC':
      return ['-c:a', 'aac', '-b:a', `${kbps}k`];
    case 'M4A':
      return ['-c:a', 'aac', '-b:a', `${kbps}k`, '-movflags', '+faststart'];
    case 'OGG':
      return ['-c:a', 'libvorbis', '-b:a', `${kbps}k`];
    case 'OPUS':
      // the wasm build of libopus crashes on stereo input; ffmpeg's own Opus encoder is solid
      return ['-c:a', 'opus', '-strict', '-2', '-b:a', `${Math.min(kbps, 256)}k`];
    case 'WMA':
      return ['-c:a', 'wmav2', '-b:a', `${Math.min(kbps, 192)}k`];
    case 'WAV':
      return ['-c:a', 'pcm_s16le'];
    case 'AIFF':
      return ['-c:a', 'pcm_s16be'];
    case 'FLAC':
      return ['-c:a', 'flac'];
  }
  return [];
}

const MPEG_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

function videoArgs(info: Probe, target: string, s: MediaSettings): string[] {
  const v = info.video!;
  const a: string[] = ['-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
  const q = clamp(s.quality, 1, 100);
  const resize = s.videoSize > 0 && v.w && v.h && Math.min(v.w, v.h) > s.videoSize;
  const audioKbps = target === 'WEBM' ? 128 : 160;

  // same codec, nothing asked to change: carry the streams across untouched, which is instant and lossless
  const container = ['MP4', 'MOV', 'M4V', 'MKV', 'TS'].includes(target);
  const sameCodec =
    (v.codec === 'h264' && s.codec === 'h264') || (v.codec === 'hevc' && s.codec === 'h265' && target !== 'TS');
  if (container && sameCodec && !resize && !s.targetMB && q === DEFAULT_QUALITY) {
    a.push('-c:v', 'copy');
    if (v.codec === 'hevc' && target !== 'MKV') a.push('-tag:v', 'hvc1');
    const ac = info.audio?.codec ?? '';
    const audioFits = target === 'MKV' || (target === 'TS' ? /^(aac|mp3|ac3)$/.test(ac) : /^(aac|alac|mp3)$/.test(ac));
    a.push(...(audioFits ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', `${audioKbps}k`]));
    if (target !== 'MKV' && target !== 'TS') a.push('-movflags', '+faststart');
    return a;
  }

  if (resize) {
    const k = s.videoSize / Math.min(v.w, v.h);
    a.push('-vf', `scale=${even(v.w * k)}:${even(v.h * k)}:flags=bicubic`);
  } else if (v.w % 2 || v.h % 2 || !v.w) {
    a.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  }

  // a size to land on overrides quality with a bitrate
  let kbps = 0;
  if (s.targetMB && info.duration > 0) {
    kbps = Math.max(60, Math.round(((s.targetMB * 8000) / info.duration) * 0.95 - (info.audio ? audioKbps : 0)));
  }
  const rate = (crf: string[]) => (kbps ? ['-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`] : crf);
  const qscale = String(Math.round(2 + (100 - q) * 0.12));

  const h264 = (extra: string[] = []) => [
    '-c:v', 'libx264', '-preset', 'veryfast', ...rate(['-crf', String(Math.round(18 + (100 - q) * 0.25))]),
    '-pix_fmt', 'yuv420p', ...extra,
  ];
  const aac = (k = audioKbps) => ['-c:a', 'aac', '-b:a', `${k}k`];

  switch (target) {
    case 'MP4':
    case 'MOV':
    case 'M4V':
    case 'MKV':
      if (s.codec === 'h265') {
        a.push(
          '-c:v', 'libx265', '-preset', 'veryfast', ...rate(['-crf', String(Math.round(23 + (100 - q) * 0.25))]),
          '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error',
        );
        if (target !== 'MKV') a.push('-tag:v', 'hvc1');
      } else {
        a.push(...h264());
      }
      a.push(...aac());
      if (target !== 'MKV') a.push('-movflags', '+faststart');
      break;
    case 'WEBM':
      a.push('-pix_fmt', 'yuv420p');
      if (s.vpx === 'vp9') {
        a.push(
          '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1',
          ...(kbps ? ['-b:v', `${kbps}k`] : ['-crf', String(Math.round(24 + (100 - q) * 0.3)), '-b:v', '0']),
        );
      } else {
        a.push(
          '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8',
          ...(kbps ? ['-b:v', `${kbps}k`] : ['-crf', String(Math.round(8 + (100 - q) * 0.3)), '-b:v', '20M']),
        );
      }
      a.push('-c:a', 'libvorbis', '-b:a', `${audioKbps}k`);
      break;
    case 'AVI':
      a.push('-c:v', 'mpeg4', '-vtag', 'xvid', ...(kbps ? ['-b:v', `${kbps}k`] : ['-q:v', qscale]));
      a.push('-c:a', 'libmp3lame', '-b:a', '192k');
      break;
    case '3GP':
      a.push(...h264(['-profile:v', 'baseline']), ...aac(96));
      break;
    case 'TS':
    case 'FLV':
      a.push(...h264(), ...aac(), ...(target === 'FLV' ? ['-ar', '44100'] : []));
      break;
    case 'OGV':
      a.push('-c:v', 'libtheora', ...(kbps ? ['-b:v', `${kbps}k`] : ['-q:v', String(Math.round(q / 10))]));
      a.push('-c:a', 'libvorbis', '-q:a', '5');
      break;
    case 'MPG': {
      a.push('-c:v', 'mpeg2video', ...(kbps ? ['-b:v', `${kbps}k`] : ['-q:v', qscale]));
      // MPEG-2 only knows the broadcast frame rates
      if (v.fps && !MPEG_RATES.some((r) => Math.abs(r - v.fps) < 0.01)) {
        const near = MPEG_RATES.reduce((b, r) => (Math.abs(r - v.fps) < Math.abs(b - v.fps) ? r : b));
        a.push('-r', String(near));
      }
      a.push('-c:a', 'mp2', '-b:a', '192k', '-ac', '2');
      break;
    }
    case 'WMV':
      a.push('-c:v', 'wmv2', ...(kbps ? ['-b:v', `${kbps}k`] : ['-q:v', qscale]));
      a.push('-c:a', 'wmav2', '-b:a', '160k');
      break;
  }
  return a;
}

function explain(lines: string[], target: string): string {
  const log = lines.join('\n');
  if (/does not contain any stream|matches no streams|Output file is empty/i.test(log))
    return `Nothing in this file can go into ${target}.`;
  if (/Invalid data found|moov atom not found|could not find codec parameters|Error opening input/i.test(log))
    return 'Couldn’t read this file. It may be damaged or incomplete.';
  if (/Cannot allocate memory|out of memory|memory access out of bounds/i.test(log))
    return 'This file is too large to convert in the browser.';
  if (/not supported|Could not find tag for codec|not currently supported in container|Unsupported/i.test(log))
    return `What’s inside this file can’t go into ${target}.`;
  return 'Couldn’t convert this file.';
}

class Friendly extends Error {}

export type MediaPhase = 'loading' | 'converting';

const stopped = () => new DOMException('Stopped', 'AbortError');

/* ffmpeg.wasm keeps one process alive across runs and doesn’t reset all of its state, so after
   enough runs (or a failed one) arguments start to come through garbled. Engines are recycled
   every few jobs, and a job that fails on a used engine gets one more go on a fresh one. */
const RECYCLE_AFTER = 6;
let runsOnEngine = 0;
let counted: Engine | null = null;

async function freshEnough(onLoad?: (p: number) => void): Promise<Engine> {
  if (live && runsOnEngine >= RECYCLE_AFTER) stopEngine();
  const e = await engine(onLoad);
  if (e !== counted) {
    counted = e;
    runsOnEngine = 0;
  }
  return e;
}

/** Audio or video to anything ffmpeg can write. */
export function convertMedia(
  file: File,
  inFmt: string,
  target: string,
  s: MediaSettings,
  progress: (phase: MediaPhase, p: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  return exclusive(async () => {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw stopped();
      progress('loading', 0);
      const eng = await freshEnough((p) => progress('loading', p));
      if (signal.aborted) throw stopped();
      const used = runsOnEngine > 0;
      runsOnEngine++;
      try {
        return await runOnce(eng, file, inFmt, target, s, progress, signal);
      } catch (e) {
        if (signal.aborted) throw stopped();
        if (attempt === 0 && used) {
          stopEngine();
          continue;
        }
        if (e instanceof Friendly) throw new Error(e.message);
        stopEngine();
        throw new Error(
          /memory|bounds|abort/i.test(String((e as Error)?.message ?? e))
            ? 'This file is too large to convert in the browser.'
            : 'Couldn’t convert this file.',
        );
      }
    }
  });
}

async function runOnce(
  { ff, mt }: Engine,
  file: File,
  inFmt: string,
  target: string,
  s: MediaSettings,
  progress: (phase: MediaPhase, p: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const id = ++seq;
  const inName = `in.${FORMATS[inFmt]?.ext ?? 'bin'}`;
  const dir = `/w${id}`;
  const output = `/w${id}-out.${FORMATS[target].ext}`;
  let input = `${dir}/${inName}`;
  let mounted = false;
  const onAbort = () => stopEngine();
  signal.addEventListener('abort', onAbort);
  try {
    progress('converting', 0);
    // read the file where it is rather than copying it into memory
    try {
      await ff.createDir(dir);
      await ff.mount('WORKERFS' as never, { files: [new File([file], inName)] }, dir);
      mounted = true;
    } catch {
      input = `/w${id}-${inName}`;
      await ff.writeFile(input, new Uint8Array(await file.arrayBuffer()));
    }

    const probeLog: string[] = [];
    const onProbe = ({ message }: LogEvent) => probeLog.push(message);
    ff.on('log', onProbe);
    try {
      await ff.exec(['-hide_banner', '-i', input]);
    } finally {
      ff.off('log', onProbe);
    }
    const info = parseProbe(probeLog.join('\n'));
    const out = FORMATS[target];

    const args = ['-hide_banner'];
    if (mt) args.push('-threads', '4');
    args.push('-i', input);
    if (out.family === 'audio') {
      if (!info.audio) throw new Friendly(info.video ? 'This video has no sound to extract.' : 'No sound found in this file.');
      args.push('-map', '0:a:0', '-vn', '-sn', '-dn', ...audioArgs(target, s.bitrate));
    } else if (target === 'GIF') {
      if (!info.video) throw new Friendly('No picture found in this file.');
      args.push(
        '-filter_complex',
        `[0:v:0]fps=${s.gifFps},scale='min(${s.gifWidth},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`,
        '-an', '-loop', '0',
      );
    } else {
      if (!info.video) throw new Friendly('No picture found in this file.');
      args.push(...videoArgs(info, target, s));
    }
    if (mt) args.push('-threads', '4');
    args.push(output);

    const lines: string[] = [];
    const onLog = ({ message }: LogEvent) => {
      lines.push(message);
      if (lines.length > 300) lines.splice(0, 150);
      const t = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
      if (t && info.duration > 0) {
        const sec = +t[1] * 3600 + +t[2] * 60 + +t[3];
        progress('converting', clamp(sec / info.duration, 0, 0.99));
      }
    };
    const onProgress = ({ progress: p }: ProgressEvent) => {
      if (!(info.duration > 0) && p >= 0 && p <= 1) progress('converting', p * 0.99);
    };
    ff.on('log', onLog);
    ff.on('progress', onProgress);
    let code: number;
    try {
      code = await ff.exec(args);
    } finally {
      ff.off('log', onLog);
      ff.off('progress', onProgress);
    }
    if (signal.aborted) throw stopped();
    if (code !== 0) throw new Friendly(explain(lines, target));
    const data = (await ff.readFile(output)) as Uint8Array;
    if (!data.length) throw new Friendly(explain(lines, target));
    progress('converting', 1);
    return new Blob([data as BlobPart], { type: out.mime });
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (live?.ff === ff) {
      await ff.deleteFile(output).catch(() => undefined);
      if (mounted) await ff.unmount(dir).catch(() => undefined);
      else await ff.deleteFile(input).catch(() => undefined);
      await ff.deleteDir(dir).catch(() => undefined);
    }
  }
}

/** WEBP for browsers whose canvas can’t write it (Safari). */
export function pngToWebp(png: Blob, quality: number): Promise<Blob> {
  return exclusive(async () => {
    const { ff } = await freshEnough();
    runsOnEngine++;
    const id = ++seq;
    const input = `/p${id}.png`;
    const output = `/p${id}.webp`;
    try {
      await ff.writeFile(input, new Uint8Array(await png.arrayBuffer()));
      const code = await ff.exec(['-hide_banner', '-i', input, '-c:v', 'libwebp', '-quality', String(quality), output]);
      if (code !== 0) throw new Error('Couldn’t write WEBP in this browser.');
      const data = (await ff.readFile(output)) as Uint8Array;
      return new Blob([data as BlobPart], { type: 'image/webp' });
    } finally {
      await ff.deleteFile(input).catch(() => undefined);
      await ff.deleteFile(output).catch(() => undefined);
    }
  });
}
