/**
 * Live preview.
 *
 * The iframe is the only place untrusted generated code renders next to the builder, so
 * its sandbox attribute is the security boundary and is set deliberately rather than
 * copied from an example.
 *
 * Granted: scripts, forms, modals, popups, and downloads, because a real app needs them.
 * Withheld: allow-top-navigation (a generated page could otherwise redirect the whole
 * builder tab to a phishing page) and allow-same-origin (which, combined with
 * allow-scripts, would let the frame reach into this origin's storage and read the
 * project). The preview is cross-origin anyway, so same-origin buys nothing but risk.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Loader2, Monitor, RefreshCw, Smartphone, Tablet } from 'lucide-react';

import type { PreviewInfo } from '../../core/types';
import type { SandboxPhase } from '../useBuilder';

const VIEWPORTS = {
  desktop: { width: null as number | null, label: 'Desktop', icon: Monitor },
  tablet: { width: 834, label: 'Tablet', icon: Tablet },
  mobile: { width: 390, label: 'Mobile', icon: Smartphone },
};

export interface PreviewPanelProps {
  preview: PreviewInfo | null;
  sandboxPhase: SandboxPhase;
  onRefresh: () => void;
  onStart: () => void;
}

export function PreviewPanel({ preview, sandboxPhase, onRefresh, onStart }: PreviewPanelProps) {
  const [viewport, setViewport] = useState<keyof typeof VIEWPORTS>('desktop');
  const [reloadKey, setReloadKey] = useState(0);
  const [expiresIn, setExpiresIn] = useState<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!preview) {
      setExpiresIn(null);
      return;
    }
    const tick = () => setExpiresIn(Math.max(0, Math.round((preview.expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [preview]);

  // Rotate before the URL dies rather than letting the user hit an expired page.
  useEffect(() => {
    if (expiresIn !== null && expiresIn > 0 && expiresIn < 60) onRefresh();
  }, [expiresIn, onRefresh]);

  const width = VIEWPORTS[viewport].width;
  const frameSrc = useMemo(
    () => (preview ? `${preview.url}${preview.url.includes('?') ? '&' : '?'}__r=${reloadKey}` : ''),
    [preview, reloadKey],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-neutral-800 px-3">
        <div className="flex items-center gap-0.5">
          {(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[]).map((key) => {
            const Icon = VIEWPORTS[key].icon;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setViewport(key)}
                title={VIEWPORTS[key].label}
                className={`rounded p-1.5 transition-colors ${
                  viewport === key ? 'bg-neutral-800 text-neutral-200' : 'text-neutral-600 hover:text-neutral-400'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {expiresIn !== null && (
            <span
              className={`tabular-nums text-[11px] ${expiresIn < 120 ? 'text-amber-500' : 'text-neutral-600'}`}
              title="The preview URL rotates automatically before it expires."
            >
              {Math.floor(expiresIn / 60)}:{String(expiresIn % 60).padStart(2, '0')}
            </span>
          )}
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={!preview}
            title="Reload"
            className="rounded p-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300 disabled:opacity-30"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {preview && (
            <a
              href={preview.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in a new tab"
              className="rounded p-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-neutral-900/40 p-3">
        {preview ? (
          <iframe
            key={frameSrc}
            ref={frameRef}
            src={frameSrc}
            title="App preview"
            // See the file header: top navigation and same-origin are withheld on purpose.
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            allow=""
            className="h-full rounded-lg border border-neutral-800 bg-white shadow-2xl"
            style={{ width: width ? `${width}px` : '100%', maxWidth: '100%' }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            {sandboxPhase === 'creating' || sandboxPhase === 'hydrating' ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-neutral-600" />
                <p className="text-xs text-neutral-500">
                  {sandboxPhase === 'creating' ? 'Starting a sandbox' : 'Loading your project into it'}
                </p>
              </>
            ) : (
              <>
                <p className="text-xs text-neutral-500">No preview running.</p>
                <button
                  type="button"
                  onClick={onStart}
                  className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
                >
                  Start the dev server
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
