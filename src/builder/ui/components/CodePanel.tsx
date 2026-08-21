/**
 * File browser and editor.
 *
 * Reuses the CodeMirror packages already in the site's dependencies. Edits go straight to
 * OPFS on save, then mirror to the sandbox, keeping the local tree authoritative.
 */

import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { EditorView } from '@codemirror/view';
import { File, FileCode, FileJson, FileText, Folder, FolderOpen, Save } from 'lucide-react';

import { extname } from '../../core/paths';

interface TreeNode {
  name: string;
  path: string;
  children?: Map<string, TreeNode>;
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() };
  for (const path of paths) {
    let node = root;
    const segments = path.split('/');
    for (const [i, segment] of segments.entries()) {
      const isFile = i === segments.length - 1;
      node.children ??= new Map();
      let child = node.children.get(segment);
      if (!child) {
        child = {
          name: segment,
          path: segments.slice(0, i + 1).join('/'),
          ...(isFile ? {} : { children: new Map() }),
        };
        node.children.set(segment, child);
      }
      node = child;
    }
  }
  return root;
}

function iconFor(name: string) {
  const ext = extname(name);
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return <FileCode className="h-3.5 w-3.5 shrink-0 text-sky-400/80" />;
  }
  if (ext === '.json') return <FileJson className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />;
  if (['.md', '.mdx', '.txt'].includes(ext)) return <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-500" />;
  return <File className="h-3.5 w-3.5 shrink-0 text-neutral-600" />;
}

function TreeView({
  node,
  depth,
  selected,
  expanded,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const entries = [...(node.children?.values() ?? [])].sort((a, b) => {
    const aDir = Boolean(a.children);
    const bDir = Boolean(b.children);
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {entries.map((entry) => {
        const isDir = Boolean(entry.children);
        const isOpen = expanded.has(entry.path);
        return (
          <div key={entry.path}>
            <button
              type="button"
              onClick={() => (isDir ? onToggle(entry.path) : onSelect(entry.path))}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              className={`flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-xs transition-colors ${
                selected === entry.path
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
              }`}
            >
              {isDir ? (
                isOpen ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-600" />
                )
              ) : (
                iconFor(entry.name)
              )}
              <span className="truncate">{entry.name}</span>
            </button>
            {isDir && isOpen && (
              <TreeView
                node={entry}
                depth={depth + 1}
                selected={selected}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', fontSize: '12.5px', height: '100%' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid rgb(38 38 38)', color: 'rgb(82 82 82)' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'rgb(163 163 163)' },
  '.cm-content': { fontFamily: 'JetBrains Mono, ui-monospace, monospace' },
  '.cm-scroller': { overflow: 'auto' },
});

export interface CodePanelProps {
  files: string[];
  readOnly: boolean;
  readFile: (path: string) => Promise<string>;
  onSave: (path: string, content: string) => void;
}

export function CodePanel({ files, readOnly, readFile, onSave }: CodePanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['app', 'src', 'lib', 'components']));

  const tree = useMemo(() => buildTree(files), [files]);

  useEffect(() => {
    if (selected && !files.includes(selected)) setSelected(null);
  }, [files, selected]);

  useEffect(() => {
    if (!selected) {
      setContent('');
      return;
    }
    let cancelled = false;
    void readFile(selected).then((text) => {
      if (!cancelled) {
        setContent(text);
        setSaved(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [readFile, selected]);

  const extensions = useMemo(() => {
    if (!selected) return [editorTheme];
    const ext = extname(selected);
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      return [javascript({ jsx: ext.endsWith('x'), typescript: ext.startsWith('.ts') }), editorTheme];
    }
    if (['.html', '.htm'].includes(ext)) return [html(), editorTheme];
    return [editorTheme];
  }, [selected]);

  const save = () => {
    if (!selected || saved || readOnly) return;
    onSave(selected, content);
    setSaved(true);
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0 overflow-y-auto border-r border-neutral-800 py-1">
        {files.length === 0 ? (
          <p className="px-3 py-4 text-xs text-neutral-600">No files yet.</p>
        ) : (
          <TreeView
            node={tree}
            depth={0}
            selected={selected}
            expanded={expanded}
            onToggle={(path) =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
            onSelect={setSelected}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-neutral-800 px-3">
              <span className="truncate font-mono text-xs text-neutral-400">{selected}</span>
              <div className="flex items-center gap-2">
                {!saved && <span className="text-[11px] text-amber-500">unsaved</span>}
                <button
                  type="button"
                  onClick={save}
                  disabled={saved || readOnly}
                  title={readOnly ? 'Read-only: this project is open in another tab' : 'Save (Cmd+S)'}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Save className="h-3 w-3" />
                  Save
                </button>
              </div>
            </div>
            <div
              className="min-h-0 flex-1 overflow-hidden"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault();
                  save();
                }
              }}
            >
              <CodeMirror
                value={content}
                height="100%"
                theme="dark"
                extensions={extensions}
                editable={!readOnly}
                onChange={(value) => {
                  setContent(value);
                  setSaved(false);
                }}
                basicSetup={{ foldGutter: false, highlightActiveLineGutter: true, autocompletion: false }}
                className="h-full"
              />
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-neutral-600">Select a file to view or edit it.</p>
          </div>
        )}
      </div>
    </div>
  );
}
