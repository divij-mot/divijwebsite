/**
 * The /builder route.
 *
 * Desktop: chat, code, and preview side by side with a collapsible log drawer.
 * Mobile: the same surfaces as tabs, because a three-pane IDE on a phone is unusable.
 *
 * Rendered without the portfolio sidebar and with no third-party scripts, which is a
 * requirement rather than a style choice: untrusted model output renders on this page.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Code2,
  Cpu,
  Download,
  History,
  Loader2,
  MessageSquare,
  Monitor,
  Plus,
  Settings2,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';

import { ChatPanel } from './components/ChatPanel';
import { CodePanel } from './components/CodePanel';
import { AuthGate, ConfirmDialog, Modal, NewProjectDialog, SettingsDialog } from './components/Dialogs';
import { PreviewPanel } from './components/PreviewPanel';
import { useBuilder } from './useBuilder';

type MobileTab = 'chat' | 'code' | 'preview' | 'logs';

function StatusDot({ phase }: { phase: string }) {
  const color =
    phase === 'ready'
      ? 'bg-emerald-500'
      : phase === 'creating' || phase === 'hydrating'
        ? 'bg-amber-500 animate-pulse'
        : phase === 'error'
          ? 'bg-red-500'
          : 'bg-neutral-600';
  return <span className={`h-1.5 w-1.5 rounded-full ${color}`} />;
}

export default function BuilderPage() {
  const { state, actions } = useBuilder();
  const [showSettings, setShowSettings] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat');
  const logsRef = useRef<HTMLDivElement>(null);

  // The builder replaces the whole viewport; the site's normal page scroll would
  // otherwise let the layout drift under the fixed panes.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    if (state.authenticated && !state.project && state.project !== undefined) {
      const timer = setTimeout(() => setShowNewProject((prev) => prev || !state.project), 400);
      return () => clearTimeout(timer);
    }
  }, [state.authenticated, state.project]);

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [state.logs]);

  const busy = state.agentStatus.phase !== 'idle' || state.busy === 'Working';

  const disabledReason = useMemo(() => {
    if (state.readOnly) return 'Read-only: this project is open in another tab.';
    if (!state.hasApiKey) return 'Add a model provider key in Settings to start.';
    if (!state.project) return 'Create or import a project first.';
    return undefined;
  }, [state.hasApiKey, state.project, state.readOnly]);

  if (state.authenticated === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950">
        <Loader2 className="h-5 w-5 animate-spin text-neutral-700" />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-neutral-950 font-sans text-neutral-200">
      {/* Toolbar */}
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 text-[13px] font-semibold tracking-tight text-neutral-100">Builder</span>
          {state.manifest && (
            <>
              <span className="text-neutral-800">/</span>
              <span className="truncate text-xs text-neutral-400">{state.manifest.name}</span>
              <span className="hidden shrink-0 rounded border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500 sm:inline">
                {state.manifest.framework}
              </span>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <div
            className="mr-1 hidden items-center gap-1.5 text-[11px] text-neutral-500 sm:flex"
            title={
              state.lease?.runtime
                ? `Runtime ${state.lease.runtime.version}, containment ${state.lease.runtime.containment}`
                : 'No sandbox running'
            }
          >
            <StatusDot phase={state.sandboxPhase} />
            <span>
              {state.sandboxPhase === 'ready'
                ? 'Sandbox ready'
                : state.sandboxPhase === 'creating'
                  ? 'Starting'
                  : state.sandboxPhase === 'hydrating'
                    ? 'Loading files'
                    : state.sandboxPhase === 'error'
                      ? 'Sandbox failed'
                      : 'No sandbox'}
            </span>
          </div>

          <ToolbarButton icon={Plus} label="New or import" onClick={() => setShowNewProject(true)} />
          <ToolbarButton
            icon={Download}
            label="Download ZIP"
            onClick={() => actions.exportProject(true)}
            disabled={!state.project}
          />
          <ToolbarButton
            icon={History}
            label="Checkpoints"
            onClick={() => setShowCheckpoints(true)}
            disabled={!state.project}
          />
          <ToolbarButton
            icon={Terminal}
            label="Logs"
            onClick={() => setShowLogs((v) => !v)}
            active={showLogs}
          />
          <ToolbarButton
            icon={Trash2}
            label="Destroy sandbox"
            onClick={() => actions.destroySandbox()}
            disabled={!state.lease}
          />
          <ToolbarButton
            icon={Settings2}
            label="Model settings"
            onClick={() => setShowSettings(true)}
            highlight={!state.hasApiKey}
          />
        </div>
      </header>

      {(state.error || state.notice) && (
        <div
          className={`flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs ${
            state.error
              ? 'border-red-900/50 bg-red-950/30 text-red-300'
              : 'border-neutral-800 bg-neutral-900 text-neutral-400'
          }`}
        >
          <span className="flex-1">{state.error ?? state.notice}</span>
          <button type="button" onClick={actions.dismiss} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Desktop */}
      <div className="hidden min-h-0 flex-1 md:flex">
        <section className="flex w-[380px] shrink-0 flex-col border-r border-neutral-800 lg:w-[420px]">
          <ChatPanel
            messages={state.messages}
            streamingText={state.streamingText}
            streamingToolEvents={state.streamingToolEvents}
            status={state.agentStatus}
            busy={busy}
            disabled={Boolean(disabledReason)}
            disabledReason={disabledReason}
            onSend={actions.sendPrompt}
            onCancel={actions.cancelTurn}
          />
        </section>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col border-r border-neutral-800">
              <CodePanel
                files={state.files}
                readOnly={state.readOnly}
                readFile={actions.readFile}
                onSave={actions.saveFile}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <PreviewPanel
                preview={state.preview}
                sandboxPhase={state.sandboxPhase}
                onRefresh={actions.refreshPreview}
                onStart={() => actions.ensureSandbox().then(() => actions.refreshPreview())}
              />
            </div>
          </div>

          {showLogs && (
            <div className="h-48 shrink-0 border-t border-neutral-800 bg-neutral-950">
              <div className="flex h-8 items-center justify-between border-b border-neutral-800 px-3">
                <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">Logs</span>
                <button
                  type="button"
                  onClick={() => setShowLogs(false)}
                  aria-label="Hide logs"
                  className="text-neutral-600 hover:text-neutral-400"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
              <LogView logs={state.logs} scrollRef={logsRef} />
            </div>
          )}
        </section>
      </div>

      {/* Mobile */}
      <div className="flex min-h-0 flex-1 flex-col md:hidden">
        <div className="min-h-0 flex-1">
          {mobileTab === 'chat' && (
            <ChatPanel
              messages={state.messages}
              streamingText={state.streamingText}
              streamingToolEvents={state.streamingToolEvents}
              status={state.agentStatus}
              busy={busy}
              disabled={Boolean(disabledReason)}
              disabledReason={disabledReason}
              onSend={actions.sendPrompt}
              onCancel={actions.cancelTurn}
            />
          )}
          {mobileTab === 'code' && (
            <CodePanel
              files={state.files}
              readOnly
              readFile={actions.readFile}
              onSave={actions.saveFile}
            />
          )}
          {mobileTab === 'preview' && (
            <PreviewPanel
              preview={state.preview}
              sandboxPhase={state.sandboxPhase}
              onRefresh={actions.refreshPreview}
              onStart={() => actions.ensureSandbox().then(() => actions.refreshPreview())}
            />
          )}
          {mobileTab === 'logs' && <LogView logs={state.logs} scrollRef={logsRef} />}
        </div>

        <nav className="flex h-14 shrink-0 items-center border-t border-neutral-800 bg-neutral-950">
          {(
            [
              ['chat', MessageSquare, 'Chat'],
              ['code', Code2, 'Code'],
              ['preview', Monitor, 'Preview'],
              ['logs', Terminal, 'Logs'],
            ] as [MobileTab, typeof Code2, string][]
          ).map(([tab, Icon, label]) => (
            <button
              key={tab}
              type="button"
              onClick={() => setMobileTab(tab)}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] ${
                mobileTab === tab ? 'text-neutral-100' : 'text-neutral-600'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Modals */}
      {!state.authenticated && (
        <AuthGate onSubmit={actions.signIn} busy={state.busy === 'Signing in'} error={state.error} />
      )}
      {state.authenticated && showNewProject && (
        <NewProjectDialog
          onCreate={async (name, withDatabase) => {
            await actions.createProject(name, withDatabase);
            setShowNewProject(false);
          }}
          onImport={async (file) => {
            await actions.importProject(file);
            setShowNewProject(false);
          }}
          onClose={() => setShowNewProject(false)}
          busy={state.busy}
          canClose={Boolean(state.project)}
        />
      )}
      {showSettings && (
        <SettingsDialog
          current={state.providerSettings}
          hasKey={state.hasApiKey}
          busy={state.busy === 'Testing the connection'}
          error={state.error}
          notice={state.notice}
          onSave={(settings, key) => actions.configureProvider(settings, key)}
          onClose={() => setShowSettings(false)}
        />
      )}
      {state.confirmation && (
        <ConfirmDialog confirmation={state.confirmation} onResolve={actions.resolveConfirmation} />
      )}
      {showCheckpoints && (
        <Modal
          title="Checkpoints"
          description="Taken before and after every agent turn. Restoring rewinds files and trims the conversation to match."
          onClose={() => setShowCheckpoints(false)}
        >
          <div className="max-h-80 space-y-1.5 overflow-y-auto">
            {state.checkpoints.length === 0 && <p className="text-xs text-neutral-600">No checkpoints yet.</p>}
            {state.checkpoints.map((checkpoint) => (
              <div
                key={checkpoint.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs text-neutral-300">{checkpoint.label}</p>
                  <p className="text-[10.5px] text-neutral-600">
                    {new Date(checkpoint.createdAt).toLocaleTimeString()} · {checkpoint.fileCount} files ·{' '}
                    {checkpoint.reason}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await actions.restoreCheckpoint(checkpoint.id);
                    setShowCheckpoints(false);
                  }}
                  className="shrink-0 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
  highlight,
}: {
  icon: typeof Cpu;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  highlight?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`relative rounded-md p-1.5 transition-colors ${
        active ? 'bg-neutral-800 text-neutral-200' : 'text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200'
      } disabled:cursor-not-allowed disabled:opacity-30`}
    >
      <Icon className="h-4 w-4" />
      {highlight && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500" />}
    </button>
  );
}

function LogView({
  logs,
  scrollRef,
}: {
  logs: { id: string; stream: string; text: string; at: number }[];
  scrollRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
    >
      {logs.length === 0 && <p className="text-neutral-700">No output yet.</p>}
      {logs.map((line) => (
        <div
          key={line.id}
          className={`whitespace-pre-wrap break-all ${
            line.stream === 'stderr'
              ? 'text-red-400/90'
              : line.stream === 'system'
                ? 'text-sky-400/80'
                : 'text-neutral-400'
          }`}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}
