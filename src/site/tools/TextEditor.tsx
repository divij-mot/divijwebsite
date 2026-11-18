import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { Page } from '../components/Page';
import {
  LANGS,
  type Lang,
  type Counts,
  langOf,
  codeLangOf,
  withLang,
  cleanName,
  countText,
  formatCounts,
  detectIndent,
  isProse,
  loadSaved,
  storeSaved,
} from './text-editor/doc';
import { createEditor, loadLanguage, type EditorHandle } from './text-editor/editor';
import './text-editor.css';

const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300..500&display=swap';
const MAX_BYTES = 25 * 1024 * 1024;

type Status = { tone: 'ok' | 'warn'; text: string; undo?: boolean };
type Snapshot = { doc: string; name: string; lang: Lang };

const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files');
const keys = (k: string) => `Meta+${k} Control+${k}`;

export default function TextEditor() {
  const saved = useMemo(loadSaved, []);
  const [name, setName] = useState(saved?.name ?? 'untitled.txt');
  const [lang, setLang] = useState<Lang>(saved?.lang ?? 'text');
  const [counts, setCounts] = useState<Counts>(() => countText(saved?.doc ?? ''));
  const [status, setStatus] = useState<Status | null>(null);
  const [statusOn, setStatusOn] = useState(false);
  const [over, setOver] = useState(false);
  const [unkept, setUnkept] = useState(false);
  const [wrap, setWrap] = useState(saved?.wrap ?? true);

  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorHandle | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const latest = useRef({ name, lang, wrap });
  latest.current = { name, lang, wrap };
  const undo = useRef<Snapshot | null>(null);
  const timers = useRef<{ store?: number; count?: number; status?: number; clear?: number; drag?: number }>({});
  const depth = useRef(0);

  /* ── keeping the document ──────────────────────────────────── */
  const persist = () => {
    const ed = editor.current;
    if (!ed) return;
    window.clearTimeout(timers.current.store);
    const { name: n, lang: l, wrap: w } = latest.current;
    setUnkept(!storeSaved({ doc: ed.view.state.doc.toString(), name: n, lang: l, wrap: w }));
  };
  const schedulePersist = () => {
    window.clearTimeout(timers.current.store);
    timers.current.store = window.setTimeout(persist, 300);
  };

  /* ── a line that says what just happened, then fades ───────── */
  const hideStatus = () => {
    window.clearTimeout(timers.current.status);
    setStatusOn(false);
    undo.current = null;
    // once it has faded, it leaves the layout
    timers.current.clear = window.setTimeout(() => setStatus(null), 500);
  };
  const flash = (s: Status, ms = 3600) => {
    window.clearTimeout(timers.current.status);
    window.clearTimeout(timers.current.clear);
    setStatus(s);
    setStatusOn(true);
    timers.current.status = window.setTimeout(hideStatus, ms);
  };
  const dismissUndo = () => {
    if (undo.current) hideStatus();
  };

  // indent the way the document already does
  const applyIndent = (doc: string, l: Lang) => editor.current?.setIndent(detectIndent(doc, l));

  /* ── actions ───────────────────────────────────────────────── */
  const openFile = async (file: File) => {
    const ed = editor.current;
    if (!ed) return;
    if (file.size > MAX_BYTES) return flash({ tone: 'warn', text: `${file.name} is too large to open` }, 6000);
    let text: string;
    try {
      text = await file.text();
    } catch {
      return flash({ tone: 'warn', text: `Couldn’t read ${file.name}` }, 6000);
    }
    if (text.slice(0, 65536).includes('\u0000')) {
      return flash({ tone: 'warn', text: `${file.name} isn’t a text file` }, 6000);
    }
    undo.current = null;
    const l = langOf(file.name);
    ed.replace(text);
    applyIndent(text, l);
    setName(file.name);
    setLang(l);
    flash({ tone: 'ok', text: `Opened ${file.name}` });
  };

  const save = () => {
    const ed = editor.current;
    if (!ed) return;
    const file = cleanName(latest.current.name, latest.current.lang);
    setName(file);
    const blob = new Blob([ed.view.state.doc.toString()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    flash({ tone: 'ok', text: `Saved ${file}` });
  };

  const newDoc = () => {
    const ed = editor.current;
    if (!ed) return;
    const doc = ed.view.state.doc.toString();
    const prev = { doc, ...latest.current };
    ed.replace('');
    applyIndent('', 'text');
    setName('untitled.txt');
    setLang('text');
    if (doc.trim()) {
      undo.current = prev;
      flash({ tone: 'ok', text: 'Cleared', undo: true }, 10000);
    }
    if (window.matchMedia('(pointer: fine)').matches) ed.view.focus();
  };

  const restore = () => {
    const prev = undo.current;
    const ed = editor.current;
    if (!prev || !ed) return;
    ed.replace(prev.doc);
    applyIndent(prev.doc, prev.lang);
    setName(prev.name);
    setLang(prev.lang);
    undo.current = null;
    flash({ tone: 'ok', text: `Restored ${prev.name}` });
  };

  const chooseLang = (l: Lang) => {
    setLang(l);
    setName((n) => withLang(n, l));
  };

  const commitName = () => {
    const n = cleanName(latest.current.name, latest.current.lang);
    setName(n);
    const l = codeLangOf(n);
    if (l && l !== latest.current.lang) setLang(l);
  };

  const endDrag = () => {
    window.clearTimeout(timers.current.drag);
    depth.current = 0;
    setOver(false);
  };

  // stable handles for the listeners set up once
  const actions = useRef({ save, openFile, schedulePersist, persist, dismissUndo, endDrag });
  actions.current = { save, openFile, schedulePersist, persist, dismissUndo, endDrag };

  /* ── the editor itself ─────────────────────────────────────── */
  useEffect(() => {
    const ed = createEditor(host.current!, {
      doc: saved?.doc ?? '',
      indent: detectIndent(saved?.doc ?? '', saved?.lang ?? 'text'),
      wrap: saved?.wrap ?? true,
      onChange: (view, typed) => {
        window.clearTimeout(timers.current.count);
        timers.current.count = window.setTimeout(() => setCounts(countText(view.state.doc.toString())), 90);
        actions.current.schedulePersist();
        if (typed) actions.current.dismissUndo();
      },
    });
    editor.current = ed;

    // the mono face is only wanted here
    let link = document.querySelector<HTMLLinkElement>('link[data-editor-font]');
    const added = !link;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = FONT_HREF;
      link.dataset.editorFont = '';
      document.head.appendChild(link);
    }
    const remeasure = () =>
      document.fonts
        .load('400 15px "Geist Mono"')
        .then(() => editor.current?.view.requestMeasure())
        .catch(() => {});
    link.addEventListener('load', remeasure, { once: true });
    remeasure();

    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        actions.current.save();
      } else if (k === 'o') {
        e.preventDefault();
        fileInput.current?.click();
      }
    };
    // a file dropped beside the editor shouldn't navigate away from it
    const refuse = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.type === 'dragover') e.dataTransfer!.dropEffect = 'none';
      if (e.type === 'drop') actions.current.endDrag();
    };
    // the blue never outlives the drag: leaving the window or cancelling ends it
    const leaveWindow = (e: DragEvent) => {
      if (!e.relatedTarget) actions.current.endDrag();
    };
    const endDrag = () => actions.current.endDrag();
    const flush = () => actions.current.persist();
    window.addEventListener('keydown', onKey);
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', refuse);
    window.addEventListener('dragleave', leaveWindow);
    window.addEventListener('dragend', endDrag);
    window.addEventListener('blur', endDrag);
    window.addEventListener('pagehide', flush);
    const t = timers.current;

    return () => {
      flush();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('dragover', refuse);
      window.removeEventListener('drop', refuse);
      window.removeEventListener('dragleave', leaveWindow);
      window.removeEventListener('dragend', endDrag);
      window.removeEventListener('blur', endDrag);
      window.removeEventListener('pagehide', flush);
      window.clearTimeout(t.store);
      window.clearTimeout(t.count);
      window.clearTimeout(t.status);
      window.clearTimeout(t.clear);
      window.clearTimeout(t.drag);
      ed.destroy();
      editor.current = null;
      if (added) link?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // grammar follows the language; a slow load never overwrites a newer choice
  useEffect(() => {
    let live = true;
    const ed = editor.current;
    if (ed) applyIndent(ed.view.state.doc.toString(), lang);
    loadLanguage(lang)
      .then((ext) => live && editor.current?.setLanguage(ext))
      .catch(() => {
        if (!live) return;
        // never leave the last language's colours on this one
        editor.current?.setLanguage([]);
        flash({ tone: 'warn', text: 'Couldn’t load the highlighting' }, 6000);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  useEffect(() => {
    editor.current?.setWrap(wrap);
  }, [wrap]);

  useEffect(() => {
    actions.current.schedulePersist();
  }, [name, lang, wrap]);

  /* ── dropping a file onto the editor ───────────────────────── */
  // capture phase, so CodeMirror never inserts the file as text
  const dragIn = (e: ReactDragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    depth.current += 1;
    setOver(true);
  };
  const dragOver = (e: ReactDragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setOver(true);
    // browsers keep firing dragover while a file is held; if they stop, so does the blue
    window.clearTimeout(timers.current.drag);
    timers.current.drag = window.setTimeout(endDrag, 1200);
  };
  const dragOut = (e: ReactDragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.stopPropagation();
    depth.current = Math.max(0, depth.current - 1);
    if (!depth.current) endDrag();
  };
  const drop = (e: ReactDragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    endDrag();
    const file = e.dataTransfer.files[0];
    if (file) openFile(file);
  };

  return (
    <Page title="Text Editor" docTitle="Text Editor">
      <div className="te">
        <p className="note te__count">
          {formatCounts(counts)}
          {unkept && (
            <>
              <br />
              <span className="u-warn">Too large to keep after a reload</span>
            </>
          )}
        </p>

        <div className="te__head">
          <label className="te__name" data-value={name}>
            <span className="sr-only">File name</span>
            <input
              ref={nameInput}
              size={1}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  nameInput.current?.blur();
                  editor.current?.view.focus();
                }
              }}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
          <div className="te__bar">
            <div className="u-actions">
              <button type="button" className="u-action" onClick={() => fileInput.current?.click()} aria-keyshortcuts={keys('O')}>
                Open
              </button>
              <button type="button" className="u-action" onClick={save} aria-keyshortcuts={keys('S')}>
                Save
              </button>
              <button type="button" className="u-action" onClick={newDoc}>
                New
              </button>
            </div>
            <p className={`note te__status${statusOn ? ' is-on' : ''}`} role="status" aria-live="polite">
              {status && (
                <>
                  <span className={status.tone === 'warn' ? 'u-warn' : 'u-muted'}>{status.text}</span>
                  {status.undo && (
                    <button type="button" className="u-action" onClick={restore} tabIndex={statusOn ? 0 : -1}>
                      Undo
                    </button>
                  )}
                </>
              )}
            </p>
          </div>
        </div>

        <div className="te__side">
          <div className="u-seg te__langs" role="group" aria-label="Language">
            {LANGS.map((l) => (
              <button type="button" key={l.id} aria-pressed={lang === l.id} onClick={() => chooseLang(l.id)}>
                {l.label}
              </button>
            ))}
          </div>
          <div className="u-seg te__opts">
            <button type="button" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
              Wrap lines
            </button>
          </div>
        </div>

        <div
          className={`te__editor${over ? ' is-over' : ''}${isProse(lang) ? ' is-prose' : ''}${wrap ? ' is-wrap' : ''}`}
          onDragEnterCapture={dragIn}
          onDragOverCapture={dragOver}
          onDragLeaveCapture={dragOut}
          onDropCapture={drop}
        >
          <div ref={host} className="te__cm" />
          <div className="te__drop" aria-hidden="true">
            <p className="te__prompt">Drop to open</p>
          </div>
        </div>

        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) openFile(f);
            e.target.value = '';
          }}
        />
      </div>
    </Page>
  );
}
