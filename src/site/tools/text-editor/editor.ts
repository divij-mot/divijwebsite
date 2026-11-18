/*
  CodeMirror, set up by hand so every piece of it is chosen: no fold arrows,
  no completion icons, no stock theme. The colours are the site's: white on
  near-black, greys for structure, the lifted blue for keywords, orange once
  (literals and the caret), deep blue under a selection.
*/
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  type Command,
} from '@codemirror/view';
import { EditorState, EditorSelection, Compartment, type Extension } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap, indentMore, indentLess } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import {
  closeBrackets,
  autocompletion,
  closeBracketsKeymap,
  completionKeymap,
  acceptCompletion,
} from '@codemirror/autocomplete';
import {
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  codeFolding,
  foldKeymap,
  indentUnit,
  LanguageDescription,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Lang } from './doc';

const white = '#ffffff';
const blue = '#0a2cf0';
const lifted = '#5a74ff';
const orange = '#ff5a1f';
const grey = (a: number) => `rgb(255 255 255 / ${a})`;
const mono = '"Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/* an action in a panel reads like .u-action: a word the orange runs through */
const word = {
  appearance: 'none',
  border: 'none',
  borderRadius: '0',
  padding: '0',
  backgroundColor: 'transparent',
  backgroundImage: `linear-gradient(90deg, ${orange} 0 50%, ${white} 50% 100%)`,
  backgroundSize: '200% 100%',
  backgroundPosition: '100% 0',
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  color: white,
  font: '400 15px/1.4 var(--sans)',
  cursor: 'pointer',
  transition: 'background-position 0.7s var(--ease)',
};

const theme = EditorView.theme(
  {
    '&': { color: white, backgroundColor: 'transparent', height: '100%', fontSize: 'var(--te-size, 15px)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: mono,
      fontWeight: '400',
      lineHeight: '1.7',
      scrollbarWidth: 'thin',
      scrollbarColor: `${grey(0.16)} transparent`,
    },
    '.cm-content': { padding: 'var(--te-pad-y) 0', caretColor: orange },
    '.cm-content:focus-visible': { outline: 'none' },
    '.cm-line': { padding: '0 var(--te-pad-x) 0 0' },

    '.cm-gutters': { backgroundColor: 'transparent', color: grey(0.22), border: 'none' },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 var(--te-num-gap, 1.6em) 0 var(--te-pad-x)',
      minWidth: '0',
      fontVariantNumeric: 'tabular-nums',
    },
    // the line you're on only shows while you're writing
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '&.cm-focused .cm-activeLine': { backgroundColor: grey(0.022) },
    '.cm-activeLineGutter': { backgroundColor: 'transparent' },
    '&.cm-focused .cm-activeLineGutter': { color: grey(0.6) },

    '.cm-cursor, .cm-dropCursor': { borderLeft: `2px solid ${orange}`, marginLeft: '-1px' },
    '.cm-selectionBackground': { backgroundColor: 'rgb(10 44 240 / 0.6)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: blue },
    // the site paints selected text ink on orange; in here it is white on blue
    '.cm-line ::selection, .cm-line::selection': { color: `${white} !important` },
    '.cm-selectionMatch': { backgroundColor: 'rgb(10 44 240 / 0.34)' },
    '&.cm-focused .cm-matchingBracket, .cm-matchingBracket': { backgroundColor: grey(0.14), color: white },
    '&.cm-focused .cm-nonmatchingBracket, .cm-nonmatchingBracket': { backgroundColor: 'transparent', color: orange },
    '.cm-searchMatch': { backgroundColor: 'rgb(255 90 31 / 0.24)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgb(255 90 31 / 0.55)' },
    '.cm-foldPlaceholder': {
      backgroundColor: grey(0.08),
      border: 'none',
      borderRadius: '0',
      color: grey(0.6),
      padding: '0 0.4em',
      margin: '0 0.3em',
    },
    '.cm-specialChar': { color: orange },

    /* completions: a quiet raised list, the chosen one on blue */
    '.cm-tooltip': { border: 'none', borderRadius: '0', backgroundColor: '#1a1a1a', color: white },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: mono, maxHeight: '15em', minWidth: '14em' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 14px', lineHeight: '1.6', color: grey(0.62) },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: blue, color: white },
    '.cm-completionIcon': { display: 'none' },
    '.cm-completionMatchedText': { textDecoration: 'none', color: white },
    '.cm-completionDetail': { fontStyle: 'normal', color: grey(0.4), marginLeft: '1em' },
    '.cm-tooltip-autocomplete-disabled > ul > li[aria-selected]': { backgroundColor: grey(0.1) },

    /* find and replace, go to line */
    '.cm-panels': { backgroundColor: '#141414', color: white, fontFamily: 'var(--sans)' },
    '.cm-panels.cm-panels-top': { borderBottom: 'none' },
    '.cm-panels.cm-panels-bottom': { borderTop: 'none' },
    '.cm-panel.cm-search, .cm-panel.cm-gotoLine': {
      padding: '14px calc(var(--te-pad-x) + 4.5em) 16px var(--te-pad-x)',
      fontSize: '15px',
      lineHeight: '1.4',
    },
    '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label, .cm-panel.cm-gotoLine input, .cm-panel.cm-gotoLine button, .cm-panel.cm-gotoLine label':
      { margin: '5px 1.5em 5px 0', verticalAlign: 'baseline' },
    '.cm-textfield': {
      appearance: 'none',
      border: 'none',
      borderRadius: '0',
      outline: 'none',
      backgroundColor: grey(0.06),
      color: white,
      caretColor: orange,
      font: '300 15px/1.4 var(--sans)',
      padding: '7px 12px',
      width: '15em',
      maxWidth: '100%',
      transition: 'background-color 0.3s ease',
    },
    '.cm-textfield:hover': { backgroundColor: grey(0.08) },
    '.cm-textfield:focus': { backgroundColor: grey(0.11) },
    '.cm-textfield::placeholder': { color: grey(0.34) },
    '.cm-button': word,
    '.cm-button:hover, .cm-button:focus-visible': { backgroundPosition: '0 0' },
    '.cm-button:active': { backgroundImage: `linear-gradient(90deg, ${orange} 0 50%, ${white} 50% 100%)` },
    '.cm-panel.cm-search label': {
      fontSize: '15px',
      color: grey(0.42),
      cursor: 'pointer',
      transition: 'color 0.3s ease',
    },
    '.cm-panel.cm-search label:hover': { color: grey(0.8) },
    '.cm-panel.cm-search label:has(input:checked)': { color: white },
    '.cm-panel.cm-search label:has(input:focus-visible)': { outline: `1px solid ${orange}`, outlineOffset: '4px' },
    '.cm-panel.cm-search input[type=checkbox]': {
      position: 'absolute',
      opacity: '0',
      width: '1px',
      height: '1px',
      margin: '0',
      pointerEvents: 'none',
    },
    '.cm-panel.cm-search [name=close], .cm-panel.cm-gotoLine [name=close]': {
      ...word,
      position: 'absolute',
      top: '26px',
      right: 'var(--te-pad-x)',
      margin: '0',
      fontSize: '0',
    },
    '.cm-panel [name=close]::after': { content: '"Close"', fontSize: '15px' },
    '.cm-panel.cm-gotoLine label': { color: grey(0.74) },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  // first, so the marks inside a heading (#) still read as marks
  { tag: t.heading, color: white, fontWeight: '500' },
  { tag: [t.keyword, t.modifier, t.self, t.tagName], color: lifted },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.invalid], color: orange },
  { tag: [t.string, t.regexp, t.character, t.attributeValue], color: grey(0.6) },
  { tag: [t.escape, t.special(t.string)], color: grey(0.86) },
  { tag: t.comment, color: grey(0.32) },
  { tag: [t.meta, t.documentMeta, t.processingInstruction, t.annotation], color: grey(0.5) },
  { tag: [t.operator, t.derefOperator], color: grey(0.6) },
  { tag: [t.punctuation, t.bracket, t.separator, t.angleBracket], color: grey(0.42) },
  { tag: [t.attributeName, t.propertyName], color: grey(0.8) },
  { tag: [t.typeName, t.className, t.namespace], color: white },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)], color: white },
  /* writing */
  { tag: t.strong, fontWeight: '500' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: lifted },
  { tag: t.url, color: grey(0.5) },
  { tag: t.monospace, color: grey(0.72) },
  { tag: t.quote, color: grey(0.72) },
  { tag: t.contentSeparator, color: grey(0.42) },
]);

const phrases = EditorState.phrases.of({
  Find: 'Find',
  Replace: 'Replace',
  next: 'Next',
  previous: 'Previous',
  all: 'All',
  'match case': 'Match case',
  regexp: 'Regex',
  'by word': 'Whole word',
  replace: 'Replace',
  'replace all': 'Replace all',
  close: 'Close',
  'Go to line': 'Go to line',
  go: 'Go',
});

/* fenced code in Markdown is highlighted too, loading its grammar on first sight */
const fencedLanguages = [
  LanguageDescription.of({
    name: 'JavaScript',
    alias: ['js', 'jsx', 'ts', 'tsx', 'typescript', 'javascript', 'json', 'mjs'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  }),
  LanguageDescription.of({ name: 'Python', alias: ['py', 'python'], load: () => import('@codemirror/lang-python').then((m) => m.python()) }),
  LanguageDescription.of({
    name: 'C++',
    alias: ['c', 'cpp', 'c++', 'cc', 'h', 'hpp'],
    load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  }),
  LanguageDescription.of({ name: 'Java', alias: ['java'], load: () => import('@codemirror/lang-java').then((m) => m.java()) }),
  LanguageDescription.of({ name: 'HTML', alias: ['html', 'htm', 'xml', 'svg'], load: () => import('@codemirror/lang-html').then((m) => m.html()) }),
];

/** Tab puts the indent where the cursor is; with a selection, it indents the lines. */
const tab: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  if (state.selection.ranges.some((r) => !r.empty)) return indentMore(view);
  const unit = state.facet(indentUnit);
  view.dispatch(
    state.changeByRange((range) => {
      const line = state.doc.lineAt(range.head);
      let insert = unit;
      if (unit !== '\t') {
        // spaces to the next stop, so columns stay aligned
        const col = range.head - line.from;
        insert = ' '.repeat(unit.length - (col % unit.length));
      }
      return { changes: { from: range.head, insert }, range: EditorSelection.cursor(range.head + insert.length) };
    }),
    { scrollIntoView: true, userEvent: 'input.indent' },
  );
  return true;
};

/** Each grammar loads only when its language is chosen. */
export function loadLanguage(lang: Lang): Promise<Extension> {
  switch (lang) {
    case 'javascript':
      return import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true }));
    case 'python':
      return import('@codemirror/lang-python').then((m) => m.python());
    case 'cpp':
      return import('@codemirror/lang-cpp').then((m) => m.cpp());
    case 'java':
      return import('@codemirror/lang-java').then((m) => m.java());
    case 'html':
      return import('@codemirror/lang-html').then((m) => m.html());
    case 'markdown':
      return import('@codemirror/lang-markdown').then((m) =>
        m.markdown({ base: m.markdownLanguage, codeLanguages: fencedLanguages }),
      );
    default:
      return Promise.resolve([]);
  }
}

export type EditorHandle = {
  view: EditorView;
  setLanguage: (ext: Extension) => void;
  setIndent: (unit: string) => void;
  setWrap: (on: boolean) => void;
  /** swap the whole document; it stays in the undo history */
  replace: (doc: string) => void;
  destroy: () => void;
};

type Options = {
  doc: string;
  indent: string;
  wrap: boolean;
  /** called on every change; `typed` is true when the person made it */
  onChange: (view: EditorView, typed: boolean) => void;
};

export function createEditor(parent: HTMLElement, opts: Options): EditorHandle {
  const language = new Compartment();
  const indent = new Compartment();
  const wrap = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        codeFolding(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(highlight),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ icons: false }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          { key: 'Tab', run: (v) => acceptCompletion(v) || tab(v), shift: indentLess },
        ]),
        indent.of(indentUnit.of(opts.indent)),
        wrap.of(opts.wrap ? EditorView.lineWrapping : []),
        EditorView.contentAttributes.of({
          'aria-label': 'Document',
          spellcheck: 'false',
          autocorrect: 'off',
          autocapitalize: 'off',
        }),
        phrases,
        theme,
        language.of([]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const typed = u.transactions.some(
            (tr) => tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move') || tr.isUserEvent('undo') || tr.isUserEvent('redo'),
          );
          opts.onChange(u.view, typed);
        }),
      ],
    }),
  });

  // a click in the margin beside a narrow measure still lands on that line
  const beside = (e: MouseEvent) => {
    if (e.button !== 0 || e.target !== view.scrollDOM) return;
    const box = view.contentDOM.getBoundingClientRect();
    if (e.clientX <= box.right || e.clientY > box.bottom) return;
    const pos = view.posAtCoords({ x: box.right - 2, y: e.clientY }, false);
    e.preventDefault();
    view.focus();
    view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' });
  };
  view.scrollDOM.addEventListener('mousedown', beside);

  return {
    view,
    setLanguage: (ext) => view.dispatch({ effects: language.reconfigure(ext) }),
    setIndent: (unit) => view.dispatch({ effects: indent.reconfigure(indentUnit.of(unit)) }),
    setWrap: (on) => view.dispatch({ effects: wrap.reconfigure(on ? EditorView.lineWrapping : []) }),
    replace: (doc) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor: 0 } });
      view.scrollDOM.scrollTop = 0;
    },
    destroy: () => {
      view.scrollDOM.removeEventListener('mousedown', beside);
      view.destroy();
    },
  };
}
