import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Page } from '../components/Page';
import {
  FORMATS,
  baseName,
  choicesFor,
  defaultTarget,
  detect,
  formatBytes,
  formatDuration,
  routeOf,
  settingsFor,
  type Caps,
  type Choices,
  type Family,
  type Format,
  type SettingKey,
} from './file-converter/formats';
import {
  DEFAULT_SETTINGS,
  combineToPdf,
  convert,
  recipeKey,
  zipFiles,
  type Output,
  type Phase,
  type Settings,
} from './file-converter/convert';
import './file-converter.css';

type Status = 'ready' | 'queued' | 'working' | 'done' | 'error';

interface Item {
  id: string;
  file: File;
  fmt: Format | null;
  target: string;
  status: Status;
  phase: Phase;
  progress: number;
  outputs: Output[] | null;
  /** object URL of a single output */
  url: string | null;
  doneKey: string | null;
  error: string | null;
  thumb: string | null;
  thumbKind: 'img' | 'video' | null;
  thumbBroken: boolean;
  meta: string | null;
  combined: boolean;
}

let uid = 0;
const nextId = () => `f${++uid}`;

/** At most `n` jobs at once; images and PDFs are heavy on memory, not on time. */
function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
const mainLane = limiter(2);

// size changes are worth showing where size is the point: pictures, video and sound
const MEDIA = new Set<Family | undefined>(['image', 'video', 'audio']);

const VIEWABLE = /^(image\/(jpeg|png|webp|avif|gif|bmp|svg)|video\/(mp4|webm)|audio\/|application\/(pdf|json)|text\/)/;
const SHOWABLE = /^image\/(jpeg|png|webp|avif|gif|bmp)/;

const FAMILY_LEAD: Record<Family, string> = {
  image: 'All images',
  video: 'All videos',
  audio: 'All audio',
  pdf: 'All PDFs',
  data: 'All tables',
};

const ACCEPT = [
  'image/*',
  'video/*',
  'audio/*',
  ...Object.values(FORMATS).map((f) => `.${f.ext}`),
  '.jpeg', '.tif', '.heif', '.aif', '.mpeg', '.mts', '.m2ts', '.qt', '.oga',
].join(',');

function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  return /’|^(This|No |Nothing|One of)/.test(m) ? m : 'Couldn’t convert this file.';
}

function save(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  save(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function mergeChoices(list: Choices[]): Choices {
  const merge = (pick: (c: Choices) => string[][]) => {
    const out: string[][] = [];
    for (const c of list) {
      pick(c).forEach((g, i) => {
        out[i] = out[i] ?? [];
        for (const x of g) if (!out[i].includes(x)) out[i].push(x);
      });
    }
    return out;
  };
  return { groups: merge((c) => c.groups), more: merge((c) => c.more) };
}

/* ── controls ─────────────────────────────────────────────────────────── */

function Chooser({
  choices,
  value,
  onChange,
  label,
  lead,
  disabled,
}: {
  choices: Choices;
  value: string;
  onChange: (v: string) => void;
  label: string;
  lead?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const extra = choices.more.flat();
  const showMore = open || extra.includes(value);
  const groups = choices.groups.map((g, i) => (showMore ? [...g, ...(choices.more[i] ?? [])] : g));
  return (
    <div className="u-seg fc-seg" role="group" aria-label={label}>
      {lead && <span className="fc-seg__lead">{lead}</span>}
      {groups.map((g, gi) =>
        g.map((x, i) => (
          <button
            key={x}
            type="button"
            className={gi > 0 && i === 0 ? 'fc-gap' : undefined}
            aria-pressed={x === value}
            disabled={disabled}
            onClick={() => onChange(x)}
          >
            {x}
          </button>
        )),
      )}
      {extra.length > 0 && !showMore && (
        <button type="button" className="fc-gap" aria-expanded={false} disabled={disabled} onClick={() => setOpen(true)}>
          More
        </button>
      )}
    </div>
  );
}

function Seg<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: [T, string][];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="u-seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function SettingsPanel({ keys, s, set }: { keys: Set<SettingKey>; s: Settings; set: (p: Partial<Settings>) => void }) {
  const [mb, setMb] = useState(s.targetMB ? String(s.targetMB) : '');
  return (
    <div className="fc-settings">
      {keys.has('quality') && (
        <label className="fc-range">
          <span className="sr-only">Quality</span>
          <input
            type="range"
            min={1}
            max={100}
            value={s.quality}
            style={{ '--v': (s.quality - 1) / 99 } as CSSProperties}
            onChange={(e) => set({ quality: Number(e.target.value) })}
          />
          <span className="note fc-num">Quality {s.quality}</span>
        </label>
      )}
      {keys.has('imageSize') && (
        <Seg
          label="Image size"
          value={s.imageSize}
          onChange={(v) => set({ imageSize: v })}
          options={[[0, 'Full size'], [4096, '4096 px'], [2048, '2048 px'], [1024, '1024 px'], [512, '512 px']]}
        />
      )}
      {keys.has('videoSize') && (
        <Seg
          label="Video resolution"
          value={s.videoSize}
          onChange={(v) => set({ videoSize: v })}
          options={[[0, 'Full resolution'], [2160, '2160p'], [1080, '1080p'], [720, '720p'], [480, '480p'], [360, '360p'], [240, '240p']]}
        />
      )}
      {(keys.has('codec') || keys.has('vpx')) && (
        <div className="fc-pair">
          {keys.has('codec') && (
            <Seg label="Video codec" value={s.codec} onChange={(v) => set({ codec: v })} options={[['h264', 'H.264'], ['h265', 'H.265']]} />
          )}
          {keys.has('vpx') && (
            <Seg label="WEBM codec" value={s.vpx} onChange={(v) => set({ vpx: v })} options={[['vp8', 'VP8'], ['vp9', 'VP9']]} />
          )}
        </div>
      )}
      {keys.has('gif') && (
        <div className="fc-pair">
          <Seg
            label="GIF width"
            value={s.gifWidth}
            onChange={(v) => set({ gifWidth: v })}
            options={[[320, '320 px'], [480, '480 px'], [640, '640 px'], [960, '960 px']]}
          />
          <Seg
            label="GIF frame rate"
            value={s.gifFps}
            onChange={(v) => set({ gifFps: v })}
            options={[[10, '10 fps'], [15, '15 fps'], [24, '24 fps']]}
          />
        </div>
      )}
      {keys.has('bitrate') && (
        <Seg
          label="Audio bitrate"
          value={s.bitrate}
          onChange={(v) => set({ bitrate: v })}
          options={[96, 128, 192, 256, 320].map((k) => [k, `${k} kbps`] as [number, string])}
        />
      )}
      {keys.has('targetMB') && (
        <label className="fc-target">
          <span className="sr-only">Target size in megabytes</span>
          <input
            className="u-field"
            type="number"
            inputMode="decimal"
            min={0.1}
            step="any"
            placeholder="Target size in MB"
            value={mb}
            onChange={(e) => {
              setMb(e.target.value);
              const n = parseFloat(e.target.value);
              set({ targetMB: isFinite(n) && n > 0 ? n : null });
            }}
          />
        </label>
      )}
    </div>
  );
}

/* ── one file ─────────────────────────────────────────────────────────── */

function Thumb({ it, onMeta, onBroken }: { it: Item; onMeta: (m: string) => void; onBroken: () => void }) {
  const single = it.outputs?.length === 1 ? it.outputs[0] : null;
  const fallback = it.thumbBroken && single && it.url && SHOWABLE.test(single.blob.type) ? it.url : null;
  const src = it.thumbBroken ? fallback : it.thumb;
  if (!src) return null;
  if (it.thumbKind === 'video' && !fallback) {
    return (
      <div className="fc-thumb">
        <video
          src={`${src}#t=0.1`}
          muted
          playsInline
          loop
          preload="metadata"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (!v.videoWidth) return onBroken();
            onMeta([formatDuration(v.duration), `${v.videoWidth} × ${v.videoHeight}`].filter(Boolean).join(' · '));
          }}
          onError={onBroken}
          onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
          onMouseLeave={(e) => e.currentTarget.pause()}
        />
      </div>
    );
  }
  return (
    <div className="fc-thumb">
      <img
        src={src}
        alt=""
        decoding="async"
        onLoad={(e) => {
          const img = e.currentTarget;
          if (!fallback && it.fmt?.family === 'image' && it.fmt.id !== 'SVG' && img.naturalWidth)
            onMeta(`${img.naturalWidth} × ${img.naturalHeight}`);
        }}
        onError={() => !fallback && onBroken()}
      />
    </div>
  );
}

function delta(from: number, to: number) {
  if (!from) return '';
  const r = to / from;
  if (r < 0.995) return `${Math.round((1 - r) * 100)}% smaller`;
  if (r > 1.005) return r < 2 ? `${Math.round((r - 1) * 100)}% larger` : `${r.toFixed(1)}× larger`;
  return 'Same size';
}

function Row({
  it,
  caps,
  many,
  onTarget,
  onStart,
  onStop,
  onRemove,
  onDownload,
  onMeta,
  onBroken,
}: {
  it: Item;
  caps: Caps;
  many: boolean;
  onTarget: (t: string) => void;
  onStart: () => void;
  onStop: () => void;
  onRemove: () => void;
  onDownload: () => void;
  onMeta: (m: string) => void;
  onBroken: () => void;
}) {
  const name = it.combined ? 'Combined.pdf' : it.file.name;
  const ext = it.file.name.match(/\.([^.]+)$/)?.[1]?.toUpperCase() ?? '';
  const kind = it.fmt?.id ?? (ext || 'File');
  const outBytes = it.outputs?.reduce((n, o) => n + o.blob.size, 0) ?? 0;
  const busy = it.status === 'queued' || it.status === 'working';
  const single = it.outputs?.length === 1 ? it.outputs[0] : null;
  const pct = Math.round(it.progress * 100);

  let line: ReactNode = null;
  if (!it.fmt) line = <p className="note u-warn">Can’t convert this kind of file.</p>;
  else if (it.status === 'error') line = <p className="note u-warn">{it.error}</p>;
  else if (it.status === 'queued') line = <p className="note u-muted">Waiting</p>;
  else if (it.status === 'working')
    line = (
      <p className="note fc-num">
        {it.phase === 'loading' ? 'Loading converter' : 'Converting'} {pct}%
      </p>
    );
  else if (it.status === 'done' && it.outputs && !it.combined) {
    const n = it.outputs.length;
    line = (
      <p className="note">
        <em>{n > 1 ? `${baseName(it.file.name)}.zip` : it.outputs[0].name}</em>
        {n > 1 ? ` · ${n} pages` : ''} · {formatBytes(outBytes)}
        {MEDIA.has(it.fmt.family) && MEDIA.has(FORMATS[it.target]?.family) && (
          <span className="u-muted"> · {delta(it.file.size, outBytes)}</span>
        )}
      </p>
    );
  }

  return (
    <li className={`fc-item is-${it.status}`}>
      <div className="fc-aside">
        <p className="note">
          {kind}
          {it.file.size ? ` · ${formatBytes(it.file.size)}` : it.combined && outBytes ? ` · ${formatBytes(outBytes)}` : ''}
          {it.meta && (
            <>
              <br />
              <span className="u-muted">{it.meta}</span>
            </>
          )}
        </p>
        <Thumb it={it} onMeta={onMeta} onBroken={onBroken} />
      </div>
      <p className="fc-name serif" title={name}>
        {name}
      </p>
      <div className="fc-body">
        {it.fmt && !it.combined && (
          <Chooser
            choices={choicesFor(it.fmt, caps)}
            value={it.target}
            onChange={onTarget}
            label={`Convert ${name} to`}
            disabled={busy}
          />
        )}
        {(it.status === 'working' || line) && (
          <div className="fc-state" aria-live="polite">
            {it.status === 'working' && (
              <div className="u-progress">
                <i style={{ '--p': it.progress } as CSSProperties} />
              </div>
            )}
            {line}
          </div>
        )}
        <div className="u-actions">
          {busy && !it.combined && (
            <button type="button" className="u-action" onClick={onStop}>
              Stop
            </button>
          )}
          {it.fmt && !busy && !it.combined && (it.status === 'error' || (it.status === 'ready' && many)) && (
            <button type="button" className="u-action" onClick={onStart}>
              {it.status === 'error' ? 'Try again' : 'Convert'}
            </button>
          )}
          {it.status === 'done' && (
            <button type="button" className="u-action" onClick={onDownload}>
              Download
            </button>
          )}
          {it.status === 'done' && single && it.url && VIEWABLE.test(single.blob.type) && (
            <a className="u-action" href={it.url} target="_blank" rel="noopener noreferrer">
              Open
            </a>
          )}
          {!busy && (
            <button type="button" className="u-action" onClick={onRemove}>
              Remove
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/* ── the page ─────────────────────────────────────────────────────────── */

export default function FileConverter() {
  const [items, setItems] = useState<Item[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [caps, setCaps] = useState<Caps>({ webp: true, avif: false });
  const [over, setOver] = useState(false);
  const [dropInView, setDropInView] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [zipping, setZipping] = useState(false);

  const itemsRef = useRef(items);
  const settingsRef = useRef(settings);
  const capsRef = useRef(caps);
  useEffect(() => {
    itemsRef.current = items;
    settingsRef.current = settings;
    capsRef.current = caps;
  });

  const controllers = useRef(new Map<string, AbortController>());
  const batch = useRef(new Set<string>());
  const mediaUsed = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const patch = useCallback((id: string, p: Partial<Item>) => {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...p } : it)));
  }, []);

  // what this browser's canvas can write
  useEffect(() => {
    let live = true;
    import('./file-converter/image').then(async ({ canvasWrites }) => {
      const [webp, avif] = await Promise.all([canvasWrites('image/webp'), canvasWrites('image/avif')]);
      if (live) setCaps({ webp, avif });
    });
    return () => {
      live = false;
    };
  }, []);

  /* adding files */

  const describe = useCallback(
    (it: Item) => {
      const fmt = it.fmt;
      if (!fmt) return;
      if (fmt.family === 'pdf') {
        import('./file-converter/pdf')
          .then(({ pdfPreview }) => pdfPreview(it.file))
          .then(({ pages, thumb }) => {
            if (!itemsRef.current.some((x) => x.id === it.id)) return;
            patch(it.id, {
              meta: `${pages} ${pages === 1 ? 'page' : 'pages'}`,
              thumb: thumb ? URL.createObjectURL(thumb) : null,
              thumbKind: 'img',
            });
          })
          .catch(() => undefined);
      } else if (fmt.family === 'audio') {
        const url = URL.createObjectURL(it.file);
        const a = new Audio();
        a.preload = 'metadata';
        const done = () => URL.revokeObjectURL(url);
        a.onloadedmetadata = () => {
          const d = formatDuration(a.duration);
          if (d) patch(it.id, { meta: d });
          done();
        };
        a.onerror = done;
        a.src = url;
      } else if (fmt.family === 'data' && it.file.size < 20e6) {
        import('./file-converter/data')
          .then(({ countRows }) => countRows(it.file, fmt.id))
          .then((n) => n && patch(it.id, { meta: `${n.toLocaleString()} ${n === 1 ? 'row' : 'rows'}` }))
          .catch(() => undefined);
      }
    },
    [patch],
  );

  const addFiles = useCallback(
    (list: FileList | File[] | null | undefined) => {
      const files = Array.from(list ?? []).filter((f) => f.size > 0 || f.type);
      if (!files.length) return;
      const fresh: Item[] = files.map((file) => {
        const fmt = detect(file);
        const visual = fmt?.family === 'image' || fmt?.family === 'video';
        return {
          id: nextId(),
          file,
          fmt,
          target: fmt ? defaultTarget(fmt, capsRef.current) : '',
          status: 'ready',
          phase: 'converting',
          progress: 0,
          outputs: null,
          url: null,
          doneKey: null,
          error: null,
          thumb: visual ? URL.createObjectURL(file) : null,
          thumbKind: fmt?.family === 'video' ? 'video' : visual ? 'img' : null,
          thumbBroken: false,
          meta: null,
          combined: false,
        };
      });
      setItems((prev) => [...prev, ...fresh]);
      fresh.forEach(describe);
    },
    [describe],
  );

  // files can land anywhere on the page, or be pasted
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const dragover = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      addFiles(e.dataTransfer?.files);
    };
    const paste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, [contenteditable="true"]')) return;
      const files = e.clipboardData?.files;
      if (files?.length) {
        e.preventDefault();
        addFiles(files);
      }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', dragover);
    window.addEventListener('drop', drop);
    document.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', dragover);
      window.removeEventListener('drop', drop);
      document.removeEventListener('paste', paste);
    };
  }, [addFiles]);

  useEffect(() => {
    const el = dropRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setDropInView(e.intersectionRatio > 0.35), { threshold: [0, 0.35, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // leaving the page stops the work and lets the memory go
  useEffect(
    () => () => {
      controllers.current.forEach((c) => c.abort());
      if (mediaUsed.current) void import('./file-converter/media').then((m) => m.stopEngine());
      void import('./file-converter/image').then((m) => m.disposeImageWorkers());
      for (const it of itemsRef.current) {
        if (it.url) URL.revokeObjectURL(it.url);
        if (it.thumb) URL.revokeObjectURL(it.thumb);
      }
    },
    [],
  );

  /* converting */

  const cleared = (it: Item): Item => {
    if (it.url) URL.revokeObjectURL(it.url);
    return { ...it, status: 'ready', progress: 0, outputs: null, url: null, doneKey: null, error: null };
  };

  const run = useCallback(
    (it: Item, s: Settings, c: Caps) => {
      const fmt = it.fmt!;
      const ac = new AbortController();
      controllers.current.set(it.id, ac);
      const route = routeOf(fmt, it.target);
      if (route === 'media' || (it.target === 'WEBP' && !c.webp)) mediaUsed.current = true;
      const key = recipeKey(fmt, it.target, s);
      let last = { phase: '', p: -1 };
      const onProgress = (phase: Phase, p: number) => {
        if (ac.signal.aborted) return;
        if (phase === last.phase && p - last.p < 0.01 && p < 1) return;
        last = { phase, p };
        patch(it.id, { status: 'working', phase, progress: p });
      };
      const job = () => convert(it.file, fmt, it.target, s, c, onProgress, ac.signal);
      const work =
        route === 'media'
          ? job()
          : mainLane(() => {
              if (ac.signal.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'));
              onProgress('converting', 0);
              return job();
            });
      work
        .then(
          (outputs) => {
            const present = itemsRef.current.some((x) => x.id === it.id);
            if (ac.signal.aborted || !present) return;
            const url = outputs.length === 1 ? URL.createObjectURL(outputs[0].blob) : null;
            patch(it.id, { status: 'done', progress: 1, outputs, url, doneKey: key, error: null });
          },
          (err) => {
            if (ac.signal.aborted) patch(it.id, { status: 'ready', progress: 0 });
            else patch(it.id, { status: 'error', error: friendly(err) });
          },
        )
        .finally(() => {
          if (controllers.current.get(it.id) === ac) controllers.current.delete(it.id);
        });
    },
    [patch],
  );

  const start = useCallback(
    (ids: string[]) => {
      const list = itemsRef.current.filter(
        (it) => ids.includes(it.id) && it.fmt && !it.combined && it.target && it.status !== 'queued' && it.status !== 'working',
      );
      if (!list.length) return;
      if (!itemsRef.current.some((it) => it.status === 'queued' || it.status === 'working')) batch.current.clear();
      list.forEach((it) => batch.current.add(it.id));
      const picked = new Set(list.map((it) => it.id));
      setItems((prev) => prev.map((it) => (picked.has(it.id) ? { ...cleared(it), status: 'queued' } : it)));
      const s = settingsRef.current;
      const c = capsRef.current;
      list.forEach((it) => run(it, s, c));
    },
    [run],
  );

  const stop = (id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    patch(id, { status: 'ready', progress: 0 });
  };

  const stopAll = () => [...controllers.current.keys()].forEach(stop);

  const remove = (id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    setItems((prev) =>
      prev.filter((it) => {
        if (it.id !== id) return true;
        if (it.url) URL.revokeObjectURL(it.url);
        if (it.thumb) URL.revokeObjectURL(it.thumb);
        return false;
      }),
    );
  };

  const clearAll = () => {
    controllers.current.forEach((c) => c.abort());
    controllers.current.clear();
    for (const it of items) {
      if (it.url) URL.revokeObjectURL(it.url);
      if (it.thumb) URL.revokeObjectURL(it.thumb);
    }
    setItems([]);
    setSettingsOpen(false);
  };

  const setTarget = (id: string, target: string) => {
    setItems((prev) => prev.map((it) => (it.id === id && it.target !== target ? { ...cleared(it), target } : it)));
  };

  const setFamilyTarget = (family: Family, target: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.combined || it.fmt?.family !== family || it.target === target) return it;
        if (it.status === 'queued' || it.status === 'working') return it;
        const c = choicesFor(it.fmt, caps);
        if (![...c.groups.flat(), ...c.more.flat()].includes(target)) return it;
        return { ...cleared(it), target };
      }),
    );
  };

  const updateSettings = (p: Partial<Settings>) => {
    const next = { ...settings, ...p };
    setSettings(next);
    // results made with other settings no longer match what’s on screen
    setItems((prev) =>
      prev.map((it) =>
        it.status === 'done' && !it.combined && it.fmt && recipeKey(it.fmt, it.target, next) !== it.doneKey ? cleared(it) : it,
      ),
    );
  };

  /* saving */

  const download = async (it: Item) => {
    if (!it.outputs) return;
    if (it.url && it.outputs.length === 1) return save(it.url, it.outputs[0].name);
    saveBlob(await zipFiles(it.outputs.map((o) => ({ path: o.name, blob: o.blob }))), `${baseName(it.file.name)}.zip`);
  };

  const downloadAll = async () => {
    const done = items.filter((it) => it.status === 'done' && it.outputs);
    if (done.length === 1) return download(done[0]);
    setZipping(true);
    try {
      const entries = done.flatMap((it) =>
        it.outputs!.length === 1
          ? [{ path: it.outputs![0].name, blob: it.outputs![0].blob }]
          : it.outputs!.map((o) => ({ path: `${baseName(it.file.name)}/${o.name}`, blob: o.blob })),
      );
      saveBlob(await zipFiles(entries), 'Converted files.zip');
    } finally {
      setZipping(false);
    }
  };

  const combine = async () => {
    const parts = items.filter((it) => !it.combined && (it.fmt?.family === 'image' || it.fmt?.family === 'pdf'));
    if (parts.length < 2) return;
    const id = nextId();
    const row: Item = {
      id,
      file: new File([], 'Combined.pdf', { type: 'application/pdf' }),
      fmt: FORMATS.PDF,
      target: '',
      status: 'working',
      phase: 'converting',
      progress: 0,
      outputs: null,
      url: null,
      doneKey: null,
      error: null,
      thumb: null,
      thumbKind: null,
      thumbBroken: false,
      meta: null,
      combined: true,
    };
    setItems((prev) => [row, ...prev]);
    try {
      const { blob, pages } = await combineToPdf(
        parts.map((it) => ({ file: it.file, fmt: it.fmt! })),
        settings,
        (p) => patch(id, { progress: p }),
      );
      if (!itemsRef.current.some((x) => x.id === id)) return;
      patch(id, {
        status: 'done',
        progress: 1,
        outputs: [{ name: 'Combined.pdf', blob }],
        url: URL.createObjectURL(blob),
        meta: `${pages} ${pages === 1 ? 'page' : 'pages'}`,
      });
    } catch (e) {
      patch(id, { status: 'error', error: friendly(e) });
    }
  };

  /* what the bar offers */

  const real = items.filter((it) => !it.combined);
  const supported = real.filter((it) => it.fmt);
  // failed files keep their own Try again; the main action is for the ones not yet run
  const convertible = supported.filter((it) => it.status === 'ready');
  const busy = items.filter((it) => it.status === 'queued' || it.status === 'working');
  const done = items.filter((it) => it.status === 'done');
  const combinable = supported.filter((it) => it.fmt!.family === 'image' || it.fmt!.family === 'pdf');
  const totalBytes = real.reduce((n, it) => n + it.file.size, 0);

  const settingKeys = useMemo(() => {
    const keys = new Set<SettingKey>();
    for (const it of items) if (it.fmt && !it.combined && it.target) settingsFor(it.fmt, it.target).forEach((k) => keys.add(k));
    return keys;
  }, [items]);

  const families = useMemo(() => {
    const by = new Map<Family, Item[]>();
    for (const it of items) {
      if (!it.fmt || it.combined) continue;
      by.set(it.fmt.family, [...(by.get(it.fmt.family) ?? []), it]);
    }
    return [...by.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([family, list]) => {
        const targets = new Set(list.map((it) => it.target));
        return {
          family,
          choices: mergeChoices(list.map((it) => choicesFor(it.fmt!, caps))),
          value: targets.size === 1 ? list[0].target : '',
        };
      });
  }, [items, caps]);

  let batchPct = 0;
  if (busy.length) {
    const inBatch = items.filter((it) => batch.current.has(it.id) || it.combined);
    const sum = inBatch.reduce(
      (n, it) =>
        n +
        (it.status === 'done' || it.status === 'error' ? 1 : it.status === 'working' && it.phase !== 'loading' ? it.progress : 0),
      0,
    );
    batchPct = Math.floor((sum / Math.max(1, inBatch.length)) * 100);
  }

  let primary: ReactNode = null;
  if (busy.length) {
    const loading = busy.find((it) => it.status === 'working' && it.phase === 'loading');
    primary = (
      <p className="fc-primary serif fc-num" aria-live="polite">
        {loading && !batchPct ? `Loading converter ${Math.round(loading.progress * 100)}%` : `Converting ${batchPct}%`}
      </p>
    );
  } else if (convertible.length) {
    const label =
      convertible.length === supported.length
        ? supported.length === 1
          ? 'Convert'
          : 'Convert all'
        : `Convert ${convertible.length} more`;
    primary = (
      <button type="button" className="u-action u-action--primary" onClick={() => start(convertible.map((it) => it.id))}>
        {label}
      </button>
    );
  } else if (done.length) {
    primary = (
      <button type="button" className="u-action u-action--primary" disabled={zipping} onClick={downloadAll}>
        {done.length > 1 ? 'Download all' : 'Download'}
      </button>
    );
  }

  return (
    <Page title="File Converter" note="In browser file conversion" docTitle="File Converter">
      <div className="fc">
        <div
          ref={dropRef}
          className={`u-drop page__col fc-drop${over ? ' is-over' : ''}${items.length ? ' is-compact' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Choose files to convert"
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
        >
          <p className="u-drop__prompt">
            <span className="fc-when-pointer">Drop files</span>
            <span className="fc-when-touch">Choose files</span>
          </p>
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            multiple
            accept={ACCEPT}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {items.length > 0 && (
          <section className="fc-list" aria-label="Files">
            <div className="row fc-bar">
              <p className="note fc-num">
                {real.length} {real.length === 1 ? 'file' : 'files'} · {formatBytes(totalBytes)}
              </p>
              <div className="fc-bar__main">
                <div className="u-actions fc-bar__actions">
                  {primary}
                  {busy.length > 0 && (
                    <button type="button" className="u-action" onClick={stopAll}>
                      Stop
                    </button>
                  )}
                  {!busy.length && convertible.length > 0 && done.length > 1 && (
                    <button type="button" className="u-action" disabled={zipping} onClick={downloadAll}>
                      Download all
                    </button>
                  )}
                  {!busy.length && combinable.length > 1 && (
                    <button type="button" className="u-action" onClick={combine}>
                      Combine into one PDF
                    </button>
                  )}
                  {!busy.length && settingKeys.size > 0 && (
                    <button type="button" className="u-action" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((o) => !o)}>
                      {settingsOpen ? 'Hide settings' : 'Settings'}
                    </button>
                  )}
                  {!busy.length && (
                    <button type="button" className="u-action" onClick={clearAll}>
                      Clear
                    </button>
                  )}
                </div>
                {!busy.length && families.length > 0 && (
                  <div className="fc-families">
                    {families.map((f) => (
                      <Chooser
                        key={f.family}
                        choices={f.choices}
                        value={f.value}
                        lead={FAMILY_LEAD[f.family]}
                        label={`Convert ${FAMILY_LEAD[f.family].toLowerCase()} to`}
                        onChange={(t) => setFamilyTarget(f.family, t)}
                      />
                    ))}
                  </div>
                )}
                {settingsOpen && !busy.length && settingKeys.size > 0 && (
                  <SettingsPanel keys={settingKeys} s={settings} set={updateSettings} />
                )}
              </div>
            </div>

            <ul className="fc-rows">
              {items.map((it) => (
                <Row
                  key={it.id}
                  it={it}
                  caps={caps}
                  many={supported.length > 1}
                  onTarget={(t) => setTarget(it.id, t)}
                  onStart={() => start([it.id])}
                  onStop={() => stop(it.id)}
                  onRemove={() => remove(it.id)}
                  onDownload={() => void download(it)}
                  onMeta={(m) => it.meta !== m && patch(it.id, { meta: m })}
                  onBroken={() => !it.thumbBroken && patch(it.id, { thumbBroken: true })}
                />
              ))}
            </ul>
          </section>
        )}
      </div>

      {over && !dropInView && (
        <div className="fc-overlay" aria-hidden="true">
          <p className="u-drop__prompt">Drop files</p>
        </div>
      )}
    </Page>
  );
}
