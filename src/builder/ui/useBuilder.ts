/**
 * The builder's state machine.
 *
 * Holds everything the panels render and owns the three moving parts: the local project
 * store (OPFS + IndexedDB), the Agent Worker, and the sandbox lease. The rule that shapes
 * it is that OPFS is the truth and the sandbox is a working copy -- so any sandbox failure
 * is recoverable by creating a new one and replaying the tree into it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { randomId } from '../core/hash';
import { PROJECT_SCHEMA_VERSION } from '../core/limits';
import { extractOversizedMarkup, safeUploadName } from '../core/pastedAssets';
import type {
  AgentStatus,
  ChatMessage,
  Checkpoint,
  LogLine,
  PreviewInfo,
  ProjectManifest,
  ProviderSettings,
  ToolEventSummary,
  WorkspaceLease,
} from '../core/types';
import { buildProjectContext } from '../agent/prompt';
import type { WorkerCommand, WorkerEvent } from '../agent/protocol';
import * as api from '../net/controlPlane';
import * as db from '../storage/db';
import { ProjectStore } from '../storage/project';
import { createNextScaffold } from '../transfer/scaffold';
import { downloadZip, exportZip, importZip } from '../transfer/zip';

const LAST_PROJECT_KEY = 'last-project-id';
const MAX_LOG_LINES = 2000;

function utf8ToBase64(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export type SandboxPhase = 'none' | 'creating' | 'hydrating' | 'ready' | 'error';

export interface PendingConfirmation {
  id: string;
  title: string;
  detail: string;
  kind: 'delete' | 'network' | 'env';
}

export interface BuilderState {
  authenticated: boolean | null;
  project: ProjectStore | null;
  manifest: ProjectManifest | null;
  files: string[];
  messages: ChatMessage[];
  streamingText: string;
  streamingToolEvents: ToolEventSummary[];
  agentStatus: AgentStatus;
  logs: LogLine[];
  sandboxPhase: SandboxPhase;
  lease: WorkspaceLease | null;
  preview: PreviewInfo | null;
  previewStarting: boolean;
  checkpoints: Checkpoint[];
  providerSettings: ProviderSettings | null;
  hasApiKey: boolean;
  readOnly: boolean;
  busy: string | null;
  error: string | null;
  notice: string | null;
  confirmation: PendingConfirmation | null;
}

export function useBuilder() {
  const [state, setState] = useState<BuilderState>({
    authenticated: null,
    project: null,
    manifest: null,
    files: [],
    messages: [],
    streamingText: '',
    streamingToolEvents: [],
    agentStatus: { phase: 'idle', step: 0, maxSteps: 20, tasks: [] },
    logs: [],
    sandboxPhase: 'none',
    lease: null,
    preview: null,
    previewStarting: false,
    checkpoints: [],
    providerSettings: null,
    hasApiKey: false,
    readOnly: false,
    busy: null,
    error: null,
    notice: null,
    confirmation: null,
  });

  const workerRef = useRef<Worker | null>(null);
  const projectRef = useRef<ProjectStore | null>(null);
  const leaseRef = useRef<WorkspaceLease | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  const probedPreviewUrlRef = useRef<string | null>(null);
  const previewPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const patch = useCallback((next: Partial<BuilderState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  const log = useCallback((stream: LogLine['stream'], text: string) => {
    setState((prev) => {
      const lines = [...prev.logs, { id: randomId('log'), stream, text, at: Date.now() }];
      return { ...prev, logs: lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES) : lines };
    });
  }, []);

  const stopPreviewPoll = useCallback(() => {
    if (previewPollRef.current != null) {
      clearTimeout(previewPollRef.current);
      previewPollRef.current = null;
    }
  }, []);

  const watchUntilLive = useCallback(
    (workspaceId: string, preview: PreviewInfo & { ready: boolean }) => {
      stopPreviewPoll();
      if (preview.ready) return;
      let attempts = 0;
      const tick = () => {
        previewPollRef.current = setTimeout(() => {
          void api
            .probePreview(workspaceId)
            .then((next) => {
              if (leaseRef.current?.workspaceId !== workspaceId) return;
              if (next.ready && next.url) {
                stopPreviewPoll();
                patch({ preview: next, previewStarting: false });
                log('system', 'Live preview is up.');
                return;
              }
              attempts += 1;
              if (attempts === 40) {
                // Do not leave the overlay up forever. First compile can take a few
                // minutes; the iframe is already loading and will paint when Next answers.
                patch({
                  preview: { ...next, ready: true, warning: next.warning },
                  previewStarting: false,
                });
                log(
                  'system',
                  'The app is still compiling. Showing the preview anyway — hit refresh if it stays blank.',
                );
              }
              if (attempts >= 80) {
                stopPreviewPoll();
                return;
              }
              tick();
            })
            .catch(() => tick());
        }, 3000);
      };
      tick();
    },
    [log, patch, stopPreviewPoll],
  );

  const refreshProject = useCallback(async () => {
    const project = projectRef.current;
    if (!project) return;
    patch({
      files: project.listPaths(),
      manifest: project.manifest,
      messages: [...project.chat],
      checkpoints: await project.listCheckpoints(),
      readOnly: project.readOnly,
    });
  }, [patch]);

  const watchStolen = useCallback(
    (project: ProjectStore) => {
      void project.lockStolen.then(() => {
        if (projectRef.current !== project) return;
        patch({
          readOnly: true,
          notice: 'Another tab took control. This one is now read-only.',
        });
      });
    },
    [patch],
  );

  // -------------------------------------------------------------------------
  // Worker
  // -------------------------------------------------------------------------

  const send = useCallback((command: WorkerCommand) => {
    workerRef.current?.postMessage(command);
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL('../agent/agent.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = async (event: MessageEvent<WorkerEvent>) => {
      const message = event.data;
      switch (message.type) {
        case 'assistant-delta':
          streamingIdRef.current = message.messageId;
          setState((prev) => ({ ...prev, streamingText: prev.streamingText + message.text }));
          break;

        case 'tool-event':
          setState((prev) => {
            const existing = prev.streamingToolEvents.findIndex((e) => e.id === message.event.id);
            const events = [...prev.streamingToolEvents];
            if (existing >= 0) events[existing] = message.event;
            else events.push(message.event);
            return { ...prev, streamingToolEvents: events };
          });
          break;

        case 'assistant-complete': {
          const project = projectRef.current;
          if (project && !project.readOnly) {
            await project.appendMessage(message.message);
            await project.createCheckpoint('post-turn', 'After agent turn');
          }
          streamingIdRef.current = null;
          patch({ streamingText: '', streamingToolEvents: [] });
          await refreshProject();
          break;
        }

        case 'status':
          patch({ agentStatus: message.status });
          break;

        case 'log':
          log(message.stream, message.text);
          break;

        case 'files-changed': {
          // Mirror the sandbox's own edits back into the durable local tree.
          const project = projectRef.current;
          if (!project || project.readOnly) break;
          for (const file of message.files) {
            if (file.deleted) {
              await project.deleteFile(file.path).catch(() => {});
            } else if (file.contentBase64) {
              const bytes = Uint8Array.from(atob(file.contentBase64), (c) => c.charCodeAt(0));
              await project.writeFile({ path: file.path, content: bytes }).catch(() => {});
            }
          }
          await refreshProject();
          break;
        }

        case 'preview-invalidated':
          if (leaseRef.current) {
            patch({ previewStarting: true });
            log('system', 'Minting a preview URL…');
            api
              .startPreview(leaseRef.current.workspaceId)
              .then((preview) => {
                patch({ preview, previewStarting: false });
                const id = leaseRef.current?.workspaceId;
                if (id) watchUntilLive(id, preview);
              })
              .catch((err) =>
                patch({
                  previewStarting: false,
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
          }
          break;

        case 'confirmation-required':
          patch({
            confirmation: {
              id: message.id,
              title: message.title,
              detail: message.detail,
              kind: message.kind,
            },
          });
          break;

        case 'connection-test':
          setState((prev) => ({
            ...prev,
            busy: null,
            error: message.result.ok ? null : message.result.errors.join(' '),
            notice: message.result.ok
              ? `Connected. ${message.result.capabilities.vision ? 'Vision supported.' : 'No vision; verification will use the DOM and console.'}`
              : null,
            providerSettings: prev.providerSettings
              ? { ...prev.providerSettings, capabilities: message.result.capabilities, verifiedAt: Date.now() }
              : prev.providerSettings,
            hasApiKey: message.result.ok ? true : prev.hasApiKey,
          }));
          if (message.result.ok) {
            const settings = await db.loadProviderSettings();
            if (settings) {
              await db.saveProviderSettings({ ...settings, capabilities: message.result.capabilities, verifiedAt: Date.now() });
            }
          }
          break;

        case 'sandbox-expired':
          stopPreviewPoll();
          patch({ sandboxPhase: 'none', lease: null, preview: null, previewStarting: false });
          leaseRef.current = null;
          log('system', 'The sandbox expired. Rebuilding it from your local copy.');
          break;

        case 'error':
          patch({ error: message.message });
          break;

        case 'turn-finished':
          patch({ busy: null });
          if (message.reason === 'step-limit') {
            patch({ notice: 'The agent hit its step limit for one turn. Ask it to continue.' });
          }
          break;

        default:
          break;
      }
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [log, patch, refreshProject, stopPreviewPoll, watchUntilLive]);

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  useEffect(() => {
    void (async () => {
      const status = await api.getAuthStatus().catch(() => ({ authenticated: false }) as api.AuthStatus);
      patch({ authenticated: status.authenticated });

      const settings = await db.loadProviderSettings();
      if (settings) patch({ providerSettings: settings });

      const lastId = await db.getSetting<string>(LAST_PROJECT_KEY);
      if (lastId) {
        try {
          const project = await ProjectStore.open(lastId);
          projectRef.current = project;
          patch({ project });
          await refreshProject();
          watchStolen(project);
          if (project.readOnly) {
            patch({ notice: 'This project is open in another tab, so this one is read-only.' });
          }
        } catch {
          await db.setSetting(LAST_PROJECT_KEY, '');
        }
      }
    })();
  }, [patch, refreshProject, watchStolen]);

  // An in-memory preview from before frame_url existed has no sibling-origin URL.
  // Reuse the Mosaic preview (do not rotate it) so the pane can load the proxy.
  useEffect(() => {
    const lease = leaseRef.current;
    const preview = state.preview;
    if (!lease || !preview || preview.frameUrl) return;
    if (probedPreviewUrlRef.current === preview.url) return;
    probedPreviewUrlRef.current = preview.url;
    void api
      .startPreview(lease.workspaceId, false)
      .then((next) => patch({ preview: next }))
      .catch(() => {});
  }, [state.preview, patch]);

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  const openProject = useCallback(
    async (project: ProjectStore) => {
      projectRef.current?.close();
      projectRef.current = project;
      await db.setSetting(LAST_PROJECT_KEY, project.projectId);
      patch({ project, sandboxPhase: 'none', lease: null, preview: null, previewStarting: false, logs: [] });
      leaseRef.current = null;
      stopPreviewPoll();
      watchStolen(project);
      await refreshProject();
    },
    [patch, refreshProject, stopPreviewPoll, watchStolen],
  );

  const createProject = useCallback(
    async (name: string, withDatabase: boolean) => {
      patch({ busy: 'Creating the project', error: null });
      try {
        const scaffold = createNextScaffold({ name, withDatabase });
        const project = await ProjectStore.create(scaffold.manifest);
        await project.writeFiles(
          Object.entries(scaffold.files).map(([path, content]) => ({ path, content })),
        );
        await project.createCheckpoint('import', 'Initial scaffold');
        await openProject(project);
        patch({ notice: `Created ${scaffold.manifest.name}.` });
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        patch({ busy: null });
      }
    },
    [openProject, patch],
  );

  const importProject = useCallback(
    async (file: File) => {
      patch({ busy: `Importing ${file.name}`, error: null });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const imported = await importZip(bytes, file.name.replace(/\.zip$/i, ''));

        const project = await ProjectStore.create(imported.manifest);
        await project.writeFiles([...imported.files].map(([path, content]) => ({ path, content })));
        if (imported.chat.length) await project.replaceChat(imported.chat);
        await project.createCheckpoint('import', `Imported ${file.name}`);
        await openProject(project);

        const notes = [
          `Imported ${imported.audit.fileCount} files.`,
          imported.restoredFromBuilder ? 'Chat history restored.' : '',
          imported.audit.rejected.length ? `${imported.audit.rejected.length} entries were skipped.` : '',
          ...imported.audit.warnings,
        ].filter(Boolean);
        patch({ notice: notes.join(' ') });
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        patch({ busy: null });
      }
    },
    [openProject, patch],
  );

  const exportProject = useCallback(
    async (includeChat = true) => {
      const project = projectRef.current;
      if (!project) return;
      patch({ busy: 'Building the archive', error: null });
      try {
        const files = new Map<string, Uint8Array>();
        for (const path of project.listPaths()) {
          files.set(path, await project.readBytes(path));
        }
        const result = await exportZip({
          manifest: project.manifest,
          files,
          chat: project.chat,
          includeChat,
          context: buildProjectContext({
            manifest: project.manifest,
            files: project.listPaths(),
            recentSummaries: project.chat
              .filter((m) => m.role === 'assistant')
              .slice(-8)
              .map((m) => m.content.slice(0, 160)),
          }),
        });

        downloadZip(result.bytes, project.manifest.name);
        patch({
          notice: `Exported ${result.fileCount} files${result.excluded.length ? `, excluding ${result.excluded.length} credential file(s)` : ''}. Drop it on vercel.com/drop to deploy.`,
        });
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        patch({ busy: null });
      }
    },
    [patch],
  );

  // -------------------------------------------------------------------------
  // Sandbox
  // -------------------------------------------------------------------------

  /**
   * Bring up a sandbox and load the project into it.
   *
   * Also the recovery path: because the local tree is the truth, rebuilding after an
   * expiry is the same operation as building for the first time.
   */
  const ensureSandbox = useCallback(async (): Promise<WorkspaceLease | null> => {
    const project = projectRef.current;
    if (!project) return null;
    if (leaseRef.current) return leaseRef.current;

    patch({ sandboxPhase: 'creating', error: null });
    log('system', 'Starting a sandbox...');

    try {
      const lease = await api.createWorkspace();
      leaseRef.current = lease;
      patch({ lease, sandboxPhase: 'hydrating' });

      if (lease.runtime && lease.runtime.containment !== 'enforced') {
        log('system', 'Warning: the sandbox reported weakened network containment.');
      }

      const syncable = project.syncableFiles();
      log('system', `Uploading ${syncable.length} files...`);

      // Batched so one oversized request cannot fail the whole hydration, and so progress
      // is visible on a large project.
      const BATCH = 40;
      for (let i = 0; i < syncable.length; i += BATCH) {
        const slice = syncable.slice(i, i + BATCH);
        const files = await Promise.all(
          slice.map(async (entry) => {
            const bytes = await project.readBytes(entry.path);
            let binary = '';
            for (let j = 0; j < bytes.length; j += 0x8000) {
              binary += String.fromCharCode(...bytes.subarray(j, j + 0x8000));
            }
            return { path: entry.path, content_base64: btoa(binary) };
          }),
        );
        await api.callTool({ workspaceId: lease.workspaceId, tool: 'fs.sync', args: { files } });
        log('system', `Uploaded ${Math.min(i + BATCH, syncable.length)}/${syncable.length}`);
      }

      patch({ sandboxPhase: 'ready' });
      log('system', 'Sandbox ready. Waiting for the app server before a preview link exists.');
      return lease;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      leaseRef.current = null;
      patch({ sandboxPhase: 'error', lease: null, error: message });
      log('system', `Could not start the sandbox: ${message}`);
      return null;
    }
  }, [log, patch]);

  const destroySandbox = useCallback(async () => {
    const lease = leaseRef.current;
    if (!lease) return;
    patch({ busy: 'Destroying the sandbox' });
    await api.destroyWorkspace(lease.workspaceId).catch(() => {});
    leaseRef.current = null;
    stopPreviewPoll();
    patch({ lease: null, preview: null, previewStarting: false, sandboxPhase: 'none', busy: null });
    log('system', 'Sandbox destroyed. Your project is safe locally.');
  }, [log, patch, stopPreviewPoll]);

  const refreshPreview = useCallback(async () => {
    const lease = leaseRef.current;
    if (!lease) return;
    stopPreviewPoll();
    patch({ previewStarting: true, error: null });
    try {
      const preview = await api.startPreview(lease.workspaceId, true);
      patch({ preview, previewStarting: false });
      if (preview.warning) log('system', preview.warning);
      watchUntilLive(lease.workspaceId, preview);
    } catch (err) {
      patch({
        previewStarting: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [log, patch, stopPreviewPoll, watchUntilLive]);

  const takeControl = useCallback(async () => {
    const project = projectRef.current;
    if (!project) return;
    patch({ busy: 'Taking control', error: null });
    try {
      const id = project.projectId;
      const next = await ProjectStore.open(id, { steal: true });
      if (next.readOnly) {
        next.close();
        patch({
          busy: null,
          error: 'Could not take control. Close the other tab, then try again.',
        });
        return;
      }
      project.close();
      projectRef.current = next;
      await db.setSetting(LAST_PROJECT_KEY, id);
      watchStolen(next);
      patch({
        project: next,
        readOnly: false,
        busy: null,
        error: null,
        notice: 'This tab is now the editor.',
      });
      await refreshProject();
    } catch (err) {
      patch({ busy: null, error: err instanceof Error ? err.message : String(err) });
    }
  }, [patch, refreshProject, watchStolen]);

  // -------------------------------------------------------------------------
  // Agent
  // -------------------------------------------------------------------------

  const sendPrompt = useCallback(
    async (prompt: string, files?: { name: string; content: string }[]) => {
      const project = projectRef.current;
      if (!project) return;
      if (project.readOnly) {
        patch({ error: 'This project is read-only because it is open in another tab.' });
        return;
      }
      if (!state.hasApiKey) {
        patch({ error: 'Add a provider API key first.' });
        return;
      }

      const uploaded: string[] = [];
      for (const file of files ?? []) {
        const path = `uploads/${safeUploadName(file.name)}`;
        await project.writeFile({ path, content: file.content });
        uploaded.push(path);
      }
      const extracted = extractOversizedMarkup(prompt);
      if (extracted.file) {
        await project.writeFile(extracted.file);
        uploaded.push(extracted.file.path);
      }
      let text = extracted.prompt.trim();
      if (uploaded.length) {
        text = [text || 'Use the attached file(s).', '', 'Attached files:', ...uploaded.map((p) => `- ${p}`)].join(
          '\n',
        );
      }
      if (!text) return;

      const lease = await ensureSandbox();
      if (!lease) return;

      if (uploaded.length && leaseRef.current) {
        await api
          .callTool({
            workspaceId: lease.workspaceId,
            tool: 'fs.sync',
            args: {
              files: await Promise.all(
                uploaded.map(async (path) => ({
                  path,
                  content_base64: utf8ToBase64(await project.readFile(path)),
                })),
              ),
            },
          })
          .catch(() => {});
      }

      const message: ChatMessage = {
        id: randomId('msg'),
        role: 'user',
        content: text,
        createdAt: Date.now(),
      };
      await project.appendMessage(message);
      await project.createCheckpoint('pre-turn', text.slice(0, 60));
      await refreshProject();

      patch({ busy: 'Working', error: null, streamingText: '', streamingToolEvents: [] });

      send({
        type: 'start-turn',
        prompt: text,
        workspaceId: lease.workspaceId,
        manifest: project.manifest,
        history: [...project.chat].slice(0, -1),
        fileCount: project.listPaths().length,
        isNewProject: project.chat.length <= 1,
        projectContext: buildProjectContext({
          manifest: project.manifest,
          files: project.listPaths(),
          recentSummaries: project.chat
            .filter((m) => m.role === 'assistant')
            .slice(-8)
            .map((m) => m.content.slice(0, 160)),
        }),
      });
    },
    [ensureSandbox, patch, refreshProject, send, state.hasApiKey],
  );

  const cancelTurn = useCallback(() => send({ type: 'cancel' }), [send]);

  const resolveConfirmation = useCallback(
    (approved: boolean) => {
      const confirmation = state.confirmation;
      if (!confirmation) return;
      send({ type: 'resolve-confirmation', id: confirmation.id, approved });
      patch({ confirmation: null });
    },
    [patch, send, state.confirmation],
  );

  const configureProvider = useCallback(
    async (settings: ProviderSettings, apiKey: string, test = true) => {
      await db.saveProviderSettings(settings);
      patch({ providerSettings: settings, hasApiKey: Boolean(apiKey), busy: test ? 'Testing the connection' : null });
      send({ type: 'configure', settings, apiKey });
      if (test) send({ type: 'test-connection', settings, apiKey });
    },
    [patch, send],
  );

  // -------------------------------------------------------------------------
  // Files and checkpoints
  // -------------------------------------------------------------------------

  const saveFile = useCallback(
    async (path: string, content: string) => {
      const project = projectRef.current;
      if (!project || project.readOnly) return;
      const changed = await project.writeFile({ path, content });
      if (!changed) return;
      await refreshProject();

      // Debounced sandbox mirroring: OPFS is written immediately because it is the truth;
      // the sandbox can lag a moment without consequence.
      const lease = leaseRef.current;
      if (!lease) return;
      const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(content)));
      void api
        .callTool({
          workspaceId: lease.workspaceId,
          tool: 'fs.sync',
          args: { files: [{ path, content_base64: encoded }] },
        })
        .catch(() => {});
    },
    [refreshProject],
  );

  const restoreCheckpoint = useCallback(
    async (checkpointId: string) => {
      const project = projectRef.current;
      if (!project) return;
      patch({ busy: 'Restoring', error: null });
      try {
        const result = await project.restoreCheckpoint(checkpointId);
        await refreshProject();
        // The sandbox now disagrees with the restored tree; rebuild it rather than trying
        // to reconcile a partial diff.
        if (leaseRef.current) {
          await api.destroyWorkspace(leaseRef.current.workspaceId).catch(() => {});
          leaseRef.current = null;
          patch({ lease: null, preview: null, sandboxPhase: 'none' });
        }
        patch({ notice: `Restored ${result.restored} files.` });
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        patch({ busy: null });
      }
    },
    [patch, refreshProject],
  );

  const readFile = useCallback(async (path: string) => {
    const project = projectRef.current;
    if (!project) return '';
    try {
      return await project.readText(path);
    } catch {
      return '';
    }
  }, []);

  const signIn = useCallback(
    async (code: string, turnstileToken?: string) => {
      patch({ busy: 'Signing in', error: null });
      try {
        await api.signIn(code, turnstileToken);
        patch({ authenticated: true });
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        patch({ busy: null });
      }
    },
    [patch],
  );

  const dismiss = useCallback(() => patch({ error: null, notice: null }), [patch]);

  const actions = useMemo(
    () => ({
      createProject,
      importProject,
      exportProject,
      openProject,
      ensureSandbox,
      destroySandbox,
      refreshPreview,
      takeControl,
      sendPrompt,
      cancelTurn,
      configureProvider,
      resolveConfirmation,
      saveFile,
      readFile,
      restoreCheckpoint,
      signIn,
      dismiss,
    }),
    [
      cancelTurn,
      configureProvider,
      createProject,
      destroySandbox,
      dismiss,
      ensureSandbox,
      exportProject,
      importProject,
      openProject,
      readFile,
      refreshPreview,
      resolveConfirmation,
      restoreCheckpoint,
      saveFile,
      sendPrompt,
      signIn,
      takeControl,
    ],
  );

  return { state, actions };
}

export const NEW_PROJECT_MANIFEST_VERSION = PROJECT_SCHEMA_VERSION;
