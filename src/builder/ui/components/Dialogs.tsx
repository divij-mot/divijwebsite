/**
 * Modal surfaces: invite gate, model settings, destructive confirmations, and the
 * new/import project dialog.
 *
 * Grouped in one file because they share the same shell and are each small; splitting
 * them would mean five files that are mostly the same wrapper.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Globe, Loader2, Trash2, X } from 'lucide-react';

import { PROVIDER_PRESETS, SUGGESTED_MODELS } from '../../agent/presets';
import type { ProviderSettings } from '../../core/types';
import type { PendingConfirmation } from '../useBuilder';

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function Modal({
  title,
  description,
  onClose,
  children,
  width = 'max-w-md',
}: {
  title: string;
  description?: string;
  onClose?: () => void;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className={`w-full ${width} rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl`}>
        <div className="flex items-start justify-between gap-4 border-b border-neutral-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
            {description && <p className="mt-1 text-xs leading-relaxed text-neutral-500">{description}</p>}
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded p-1 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none';

const primaryButton =
  'w-full rounded-lg bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40';

// ---------------------------------------------------------------------------
// Invite gate
// ---------------------------------------------------------------------------

export function AuthGate({
  onSubmit,
  busy,
  error,
}: {
  onSubmit: (code: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const [code, setCode] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  return (
    <Modal
      title="Invite required"
      description="This builder is in a private beta. Enter your invite code to continue."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) onSubmit(code.trim());
        }}
        className="space-y-3"
      >
        <input
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Invite code"
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button type="submit" disabled={busy || !code.trim()} className={primaryButton}>
          {busy ? 'Checking' : 'Continue'}
        </button>
        <p className="pt-1 text-[11px] leading-relaxed text-neutral-600">
          Your projects and chats stay in this browser. Nothing you build is stored on the server.
        </p>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Model settings
// ---------------------------------------------------------------------------

export function SettingsDialog({
  current,
  hasKey,
  busy,
  error,
  notice,
  onSave,
  onClose,
}: {
  current: ProviderSettings | null;
  hasKey: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onSave: (settings: ProviderSettings, apiKey: string) => void;
  onClose: () => void;
}) {
  const [presetId, setPresetId] = useState(current?.presetId ?? 'openai');
  const [model, setModel] = useState(current?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) ?? PROVIDER_PRESETS[0];
  const isCustom = preset.id === 'custom';
  const effectiveModel = model || preset.defaultModel;

  const submit = () => {
    if (!apiKey.trim() || !effectiveModel.trim()) return;
    onSave(
      {
        presetId: preset.id,
        model: effectiveModel.trim(),
        baseUrl: isCustom ? baseUrl.trim() : undefined,
        protocol: preset.protocol,
        transport: preset.transport,
        capabilities: current?.capabilities,
      },
      apiKey.trim(),
    );
  };

  return (
    <Modal
      title="Model settings"
      description="Bring your own key. It is kept in memory only and is required again after a reload."
      onClose={onClose}
      width="max-w-lg"
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-neutral-400">Provider</label>
          <div className="grid grid-cols-2 gap-2">
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setPresetId(p.id);
                  setModel(p.defaultModel);
                }}
                className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                  presetId === p.id
                    ? 'border-neutral-500 bg-neutral-800 text-neutral-100'
                    : 'border-neutral-800 text-neutral-400 hover:border-neutral-700'
                }`}
              >
                <div className="font-medium">{p.label}</div>
                <div className="mt-0.5 text-[10.5px] text-neutral-600">
                  {p.transport === 'relay' ? 'Relayed, no CORS needed' : 'Called directly from your browser'}
                </div>
              </button>
            ))}
          </div>
        </div>

        {isCustom && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-neutral-400">Base URL</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-endpoint.example.com"
              className={inputClass}
              spellCheck={false}
            />
            <p className="mt-1 text-[11px] text-neutral-600">
              Requests go straight from your browser, so the endpoint must allow this origin with CORS
              headers. Your key never reaches our server.
            </p>
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-xs font-medium text-neutral-400">Model</label>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={preset.defaultModel || 'model-id'}
            className={inputClass}
            spellCheck={false}
          />
          {SUGGESTED_MODELS[preset.id]?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {SUGGESTED_MODELS[preset.id].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setModel(m)}
                  className="rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10.5px] text-neutral-500 hover:border-neutral-600 hover:text-neutral-300"
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-neutral-400">
            API key {hasKey && <span className="text-emerald-500">(set for this session)</span>}
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasKey ? 'Enter a new key to replace it' : 'sk-...'}
            className={inputClass}
            autoComplete="off"
            spellCheck={false}
          />
          {preset.docsUrl && (
            <a
              href={preset.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block text-[11px] text-sky-500 hover:text-sky-400"
            >
              Get a key
            </a>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        {notice && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-900/60 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-300">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{notice}</span>
          </div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={busy || !apiKey.trim() || !effectiveModel.trim() || (isCustom && !baseUrl.trim())}
          className={primaryButton}
        >
          {busy ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Testing authentication, streaming, and tool calls
            </span>
          ) : (
            'Save and test the connection'
          )}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

export function ConfirmDialog({
  confirmation,
  onResolve,
}: {
  confirmation: PendingConfirmation;
  onResolve: (approved: boolean) => void;
}) {
  const Icon = confirmation.kind === 'network' ? Globe : confirmation.kind === 'delete' ? Trash2 : AlertTriangle;

  return (
    <Modal title={confirmation.title} onClose={() => onResolve(false)}>
      <div className="space-y-4">
        <div className="flex gap-3">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-xs leading-relaxed text-neutral-400">{confirmation.detail}</p>
        </div>
        {confirmation.kind === 'network' && (
          <p className="rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-[11px] leading-relaxed text-neutral-500">
            The sandbox can only reach package registries. Approving this lets it connect to one more
            host for this session, and the connection is still checked against private and internal
            addresses.
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onResolve(false)}
            className="flex-1 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => onResolve(true)}
            className="flex-1 rounded-lg bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 hover:opacity-90"
          >
            Approve
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// New project
// ---------------------------------------------------------------------------

export function NewProjectDialog({
  onCreate,
  onImport,
  onClose,
  busy,
  canClose,
}: {
  onCreate: (name: string, withDatabase: boolean) => void;
  onImport: (file: File) => void;
  onClose: () => void;
  busy: string | null;
  canClose: boolean;
}) {
  const [name, setName] = useState('my-app');
  const [withDatabase, setWithDatabase] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <Modal
      title="Start a project"
      description="New projects are Next.js App Router with TypeScript and Tailwind, ready to deploy to Vercel."
      onClose={canClose ? onClose : undefined}
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-neutral-400">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} spellCheck={false} />
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-neutral-800 p-3 hover:border-neutral-700">
          <input
            type="checkbox"
            checked={withDatabase}
            onChange={(e) => setWithDatabase(e.target.checked)}
            className="mt-0.5 accent-neutral-200"
          />
          <span className="text-xs">
            <span className="font-medium text-neutral-200">Include a database</span>
            <span className="mt-0.5 block leading-relaxed text-neutral-500">
              Adds Drizzle, Postgres migrations, and a /setup page. It still builds and runs without
              credentials, so your first deploy works before you connect anything.
            </span>
          </span>
        </label>

        <button
          type="button"
          onClick={() => onCreate(name, withDatabase)}
          disabled={Boolean(busy) || !name.trim()}
          className={primaryButton}
        >
          {busy === 'Creating the project' ? 'Creating' : 'Create'}
        </button>

        <div className="flex items-center gap-3 py-1">
          <div className="h-px flex-1 bg-neutral-800" />
          <span className="text-[11px] text-neutral-600">or</span>
          <div className="h-px flex-1 bg-neutral-800" />
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImport(file);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={Boolean(busy)}
          className="w-full rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
        >
          {busy?.startsWith('Importing') ? busy : 'Import a ZIP'}
        </button>
        <p className="text-[11px] leading-relaxed text-neutral-600">
          Any JavaScript or TypeScript project works. A ZIP exported from this builder also restores
          its chat history.
        </p>
      </div>
    </Modal>
  );
}

export { Modal };
