/// <reference lib="webworker" />
/**
 * The Agent Worker.
 *
 * Owns the provider credential, the conversation as the model sees it, the tool loop, and
 * cancellation. It runs off the main thread so a long turn never blocks the editor, and
 * so the API key lives somewhere the UI cannot read.
 *
 * The key is held in a module-scoped variable and is never posted back, never written to
 * IndexedDB, and never included in any event. Reloading the tab loses it, which is the
 * intended trade.
 */

import { AGENT_LIMITS, TIMEOUTS_MS } from '../core/limits';
import { randomId } from '../core/hash';
import type { AgentTask, ChatMessage, ProviderSettings, ToolEventSummary } from '../core/types';
import { allowEgressHost, callTool, ControlPlaneError } from '../net/controlPlane';
import { getPreset } from './presets';
import { buildSystemPrompt } from './prompt';
import { createChatCompletionsAdapter } from './providers/chatCompletions';
import { createResponsesAdapter } from './providers/responses';
import type { ProviderAdapter, ToolCallRequest, TurnMessage } from './providers/types';
import type { WorkerCommand, WorkerEvent } from './protocol';
import { AGENT_TOOLS, MUTATING_TOOLS, TOOL_NAME_TO_ENDPOINT } from './tools';

declare const self: DedicatedWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let apiKey = '';
let adapter: ProviderAdapter | null = null;
let settings: ProviderSettings | null = null;
let turnController: AbortController | null = null;
let tasks: AgentTask[] = [];

const pendingConfirmations = new Map<string, (approved: boolean) => void>();

const post = (event: WorkerEvent) => self.postMessage(event);

function buildAdapter(next: ProviderSettings): ProviderAdapter {
  const preset = getPreset(next.presetId);
  return next.protocol === 'openai-responses'
    ? createResponsesAdapter(preset, next.baseUrl)
    : createChatCompletionsAdapter(preset, next.baseUrl);
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

interface ToolOutcome {
  /** What the model sees. */
  content: string;
  images?: string[];
  summary: ToolEventSummary;
  mutated: boolean;
}

function parseArguments(call: ToolCallRequest): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const raw = call.argumentsJson?.trim();
  if (!raw) return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, args: parsed as Record<string, unknown> };
    }
    return { ok: false, error: 'Tool arguments must be a JSON object.' };
  } catch (err) {
    // Truncated JSON usually means the model hit its output limit mid-call. Saying so
    // lets it retry with a smaller payload instead of repeating the same failure.
    return {
      ok: false,
      error: `Could not parse the tool arguments as JSON (${(err as Error).message}). If the arguments were long, send a smaller call.`,
    };
  }
}

async function askUser(
  kind: 'delete' | 'network' | 'env',
  title: string,
  detail: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const id = randomId('confirm');
  post({ type: 'confirmation-required', id, title, detail, kind, payload });
  return new Promise<boolean>((resolve) => {
    pendingConfirmations.set(id, resolve);
    // A confirmation that is never answered must not hold the turn open forever.
    setTimeout(() => {
      if (pendingConfirmations.delete(id)) resolve(false);
    }, 5 * 60_000);
  });
}

async function runTool(
  call: ToolCallRequest,
  workspaceId: string,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const started = Date.now();
  const summaryBase = { id: call.id, tool: call.name, startedAt: started };

  const parsed = parseArguments(call);
  if (!parsed.ok) {
    return {
      content: parsed.error,
      mutated: false,
      summary: { ...summaryBase, title: call.name, status: 'error', detail: parsed.error, endedAt: Date.now() },
    };
  }
  const args = parsed.args;

  // ---- tools handled here rather than in the sandbox ----

  if (call.name === 'set_tasks') {
    const incoming = Array.isArray(args.tasks) ? (args.tasks as { title: string; status: AgentTask['status'] }[]) : [];
    tasks = incoming.map((t, i) => ({ id: `t${i}`, title: String(t.title), status: t.status ?? 'pending' }));
    post({ type: 'status', status: { phase: 'tool', step: 0, maxSteps: AGENT_LIMITS.maxToolStepsPerTurn, tasks } });
    return {
      content: `Task list updated (${tasks.length} items).`,
      mutated: false,
      summary: { ...summaryBase, title: 'Updated the plan', status: 'ok', endedAt: Date.now() },
    };
  }

  if (call.name === 'request_network_access') {
    const hostname = String(args.hostname ?? '');
    const reason = String(args.reason ?? '');
    const approved = await askUser(
      'network',
      `Allow the sandbox to reach ${hostname}?`,
      reason,
      { hostname },
    );
    if (!approved) {
      return {
        content: `The user declined access to ${hostname}. Do not retry; build the feature without it, or explain why it cannot be done.`,
        mutated: false,
        summary: { ...summaryBase, title: `Network access to ${hostname} declined`, status: 'denied', endedAt: Date.now() },
      };
    }
    try {
      await allowEgressHost(workspaceId, hostname);
      return {
        content: `${hostname} is now reachable from the sandbox.`,
        mutated: false,
        summary: { ...summaryBase, title: `Allowed ${hostname}`, status: 'ok', endedAt: Date.now() },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Could not allow ${hostname}: ${message}`,
        mutated: false,
        summary: { ...summaryBase, title: `Could not allow ${hostname}`, status: 'error', detail: message, endedAt: Date.now() },
      };
    }
  }

  // ---- sandbox tools ----

  const endpoint = TOOL_NAME_TO_ENDPOINT[call.name];
  if (!endpoint) {
    return {
      content: `No such tool: ${call.name}`,
      mutated: false,
      summary: { ...summaryBase, title: call.name, status: 'error', endedAt: Date.now() },
    };
  }

  const logLines: string[] = [];
  try {
    let data = await callTool<Record<string, unknown>>({
      workspaceId,
      tool: endpoint,
      args,
      signal,
      onEvent: (event) => {
        if (event.kind === 'stdout' || event.kind === 'stderr') {
          post({ type: 'log', stream: event.kind, text: event.text ?? '' });
          logLines.push(event.text ?? '');
        } else if (event.kind === 'progress' && event.text) {
          post({ type: 'log', stream: 'system', text: event.text });
        }
      },
    });

    // A destructive call comes back asking for confirmation instead of acting.
    if ((data as { __confirmationRequired?: boolean }).__confirmationRequired) {
      const info = data as { reason?: string; paths?: string[] };
      const approved = await askUser(
        'delete',
        'Confirm a destructive change',
        info.reason ?? 'The agent wants to delete files.',
        { paths: info.paths ?? [] },
      );
      if (!approved) {
        return {
          content: 'The user declined this deletion. Leave those files alone and continue.',
          mutated: false,
          summary: { ...summaryBase, title: 'Deletion declined', status: 'denied', endedAt: Date.now() },
        };
      }
      data = await callTool<Record<string, unknown>>({
        workspaceId,
        tool: endpoint,
        args: { ...args, confirmed: true },
        signal,
      });
    }

    const images: string[] = [];
    if (typeof (data as { image_base64?: string }).image_base64 === 'string') {
      images.push(`data:image/jpeg;base64,${(data as { image_base64: string }).image_base64}`);
      // Drop the bytes from the text payload; the image rides as a real image part.
      delete (data as { image_base64?: string }).image_base64;
    }

    return {
      content: JSON.stringify(data).slice(0, AGENT_LIMITS.maxToolOutputBytes),
      images: images.length ? images : undefined,
      mutated: MUTATING_TOOLS.has(call.name),
      summary: {
        ...summaryBase,
        title: describeCall(call.name, args),
        status: 'ok',
        detail: describeResult(call.name, data),
        paths: extractPaths(args, data),
        endedAt: Date.now(),
      },
    };
  } catch (err) {
    if (err instanceof ControlPlaneError && err.isSandboxGone) {
      post({ type: 'sandbox-expired' });
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Tool failed: ${message}`,
      mutated: MUTATING_TOOLS.has(call.name),
      summary: { ...summaryBase, title: describeCall(call.name, args), status: 'error', detail: message, endedAt: Date.now() },
    };
  }
}

function describeCall(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'fs_read':
      return `Read ${(args.paths as string[] | undefined)?.length ?? 1} file(s)`;
    case 'fs_write':
      return `Wrote ${(args.files as unknown[] | undefined)?.length ?? 1} file(s)`;
    case 'fs_patch':
      return `Edited ${String(args.path ?? '')}`;
    case 'fs_search':
      return `Searched for "${String(args.query ?? '')}"`;
    case 'fs_delete':
      return `Deleted ${(args.paths as string[] | undefined)?.length ?? 0} path(s)`;
    case 'shell_run':
      return String(args.command ?? 'Ran a command').slice(0, 90);
    case 'pkg_install':
      return `Installed ${(args.packages as string[] | undefined)?.join(', ') || 'dependencies'}`;
    case 'browser_action':
      return `Browser: ${String(args.action ?? '')}`;
    case 'verify_build':
      return 'Typecheck and build';
    case 'dev_start':
      return 'Started the dev server';
    default:
      return tool.replace(/_/g, ' ');
  }
}

function describeResult(tool: string, data: Record<string, unknown>): string | undefined {
  if (typeof data.exit_code === 'number' && data.exit_code !== 0) return `exit code ${data.exit_code}`;
  if (tool === 'verify_build') return data.ok ? 'passed' : 'failed';
  if (tool === 'fs_tree' && typeof data.count === 'number') return `${data.count} files`;
  if (tool === 'fs_search' && typeof data.count === 'number') return `${data.count} matches`;
  if (tool === 'dev_start') return data.ready ? 'ready' : 'not responding yet';
  return undefined;
}

function extractPaths(args: Record<string, unknown>, data: Record<string, unknown>): string[] | undefined {
  const out = new Set<string>();
  if (typeof args.path === 'string') out.add(args.path);
  for (const p of (args.paths as string[] | undefined) ?? []) out.add(p);
  for (const f of (args.files as { path?: string }[] | undefined) ?? []) if (f.path) out.add(f.path);
  for (const p of (data.paths as string[] | undefined) ?? []) out.add(p);
  return out.size ? [...out] : undefined;
}

/**
 * Pull files the sandbox changed back into the browser.
 *
 * Anything the agent does through a shell command -- a scaffolder, a codemod, a formatter
 * -- creates files the browser has never seen. Without this they exist only in the
 * sandbox and vanish with it.
 */
async function mirrorChanges(workspaceId: string, signal: AbortSignal): Promise<void> {
  try {
    const data = await callTool<{
      changed: { path: string; status: string }[];
      contents: Record<string, string>;
    }>({ workspaceId, tool: 'fs.changes', args: { include_content: true }, signal });

    if (!data.changed?.length) return;
    post({
      type: 'files-changed',
      files: data.changed.map((c) => ({
        path: c.path,
        contentBase64: data.contents[c.path] ?? null,
        deleted: c.status === 'deleted',
      })),
    });
  } catch {
    // A failed mirror is recoverable: the next successful one picks up the same files.
  }
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

async function runTurn(command: Extract<WorkerCommand, { type: 'start-turn' }>): Promise<void> {
  const active = settings;
  if (!adapter || !apiKey || !active) {
    post({ type: 'error', message: 'Add a provider API key before starting a turn.', fatal: false });
    post({ type: 'turn-finished', reason: 'error' });
    return;
  }

  turnController = new AbortController();
  const { signal } = turnController;
  const hardStop = setTimeout(() => turnController?.abort(), TIMEOUTS_MS.agentTurn);

  tasks = [];
  const messageId = randomId('msg');
  const toolEvents: ToolEventSummary[] = [];
  let assistantText = '';
  let mutatedThisTurn = false;

  const conversation: TurnMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        manifest: command.manifest,
        capabilities: active.capabilities ?? { streaming: true, functionCalling: true, vision: false },
        fileCount: command.fileCount,
        projectContext: command.projectContext,
        isNewProject: command.isNewProject,
      }),
    },
    // Prior turns are replayed as plain text. Their tool traffic is deliberately not
    // resent: it would dominate the context window, and the summaries carry what matters.
    ...command.history
      .filter((m) => m.role !== 'system' && m.content.trim())
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: command.prompt },
  ];

  const status = (phase: 'thinking' | 'tool' | 'verifying', step: number, message?: string) =>
    post({
      type: 'status',
      status: { phase, step, maxSteps: AGENT_LIMITS.maxToolStepsPerTurn, tasks, message },
    });

  try {
    for (let step = 0; step < AGENT_LIMITS.maxToolStepsPerTurn; step += 1) {
      if (signal.aborted) break;
      status('thinking', step);

      const calls: ToolCallRequest[] = [];
      let stepText = '';
      let providerError: string | null = null;

      for await (const event of adapter.stream({
        model: active.model,
        messages: conversation,
        tools: AGENT_TOOLS,
        apiKey,
        signal,
        safetyIdentifier: active.presetId === 'openai',
      })) {
        if (event.type === 'text-delta') {
          stepText += event.text;
          assistantText += event.text;
          post({ type: 'assistant-delta', messageId, text: event.text });
        } else if (event.type === 'tool-call') {
          calls.push(event.call);
        } else if (event.type === 'error') {
          providerError = event.message;
          break;
        }
      }

      if (providerError) {
        post({ type: 'error', message: providerError, fatal: false });
        assistantText += `${assistantText ? '\n\n' : ''}The model provider returned an error: ${providerError}`;
        break;
      }
      if (signal.aborted) break;

      if (!calls.length) {
        // No tools requested: the model considers itself done.
        break;
      }

      conversation.push({ role: 'assistant', content: stepText, toolCalls: calls });

      for (const call of calls) {
        if (signal.aborted) break;
        status('tool', step, describeCall(call.name, {}));

        const running: ToolEventSummary = {
          id: call.id,
          tool: call.name,
          title: describeCall(call.name, {}),
          status: 'running',
          startedAt: Date.now(),
        };
        post({ type: 'tool-event', messageId, event: running });

        const outcome = await runTool(call, command.workspaceId, signal);
        toolEvents.push(outcome.summary);
        post({ type: 'tool-event', messageId, event: outcome.summary });
        mutatedThisTurn ||= outcome.mutated;

        conversation.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: outcome.content,
          images: active.capabilities?.vision ? outcome.images : undefined,
        });

        if (call.name === 'dev_start' || call.name === 'verify_build') {
          post({ type: 'preview-invalidated' });
        }
      }

      if (step === AGENT_LIMITS.maxToolStepsPerTurn - 1) {
        post({ type: 'turn-finished', reason: 'step-limit' });
        assistantText += `${assistantText ? '\n\n' : ''}I reached the ${AGENT_LIMITS.maxToolStepsPerTurn}-step limit for a single turn. Tell me to continue and I will pick up from here.`;
      }
    }

    if (mutatedThisTurn && !signal.aborted) {
      status('verifying', AGENT_LIMITS.maxToolStepsPerTurn, 'Saving changes locally');
      await mirrorChanges(command.workspaceId, signal);
    }

    const message: ChatMessage = {
      id: messageId,
      role: 'assistant',
      content: assistantText.trim() || 'Done.',
      createdAt: Date.now(),
      toolEvents,
      interrupted: signal.aborted || undefined,
    };
    post({ type: 'assistant-complete', message });
    post({ type: 'turn-finished', reason: signal.aborted ? 'cancelled' : 'done' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({
      type: 'assistant-complete',
      message: {
        id: messageId,
        role: 'assistant',
        content: assistantText.trim() || 'The turn failed before I could respond.',
        createdAt: Date.now(),
        toolEvents,
        error: message,
      },
    });
    post({ type: 'error', message, fatal: false });
    post({ type: 'turn-finished', reason: 'error' });
  } finally {
    clearTimeout(hardStop);
    turnController = null;
    post({ type: 'status', status: { phase: 'idle', step: 0, maxSteps: AGENT_LIMITS.maxToolStepsPerTurn, tasks } });
  }
}

// ---------------------------------------------------------------------------
// Message pump
// ---------------------------------------------------------------------------

self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;

  switch (command.type) {
    case 'configure': {
      apiKey = command.apiKey;
      settings = command.settings;
      adapter = buildAdapter(command.settings);
      post({ type: 'configured', capabilities: command.settings.capabilities });
      break;
    }

    case 'test-connection': {
      const probeAdapter = buildAdapter(command.settings);
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      try {
        const probe = await probeAdapter.test(command.apiKey, command.settings.model, controller.signal);
        post({
          type: 'connection-test',
          result: {
            ok: probe.errors.length === 0,
            capabilities: probe.capabilities,
            model: command.settings.model,
            latencyMs: Date.now() - started,
            errors: probe.errors,
            warnings: probe.warnings,
          },
        });
      } catch (err) {
        post({
          type: 'connection-test',
          result: {
            ok: false,
            capabilities: { streaming: false, functionCalling: false, vision: false },
            model: command.settings.model,
            latencyMs: Date.now() - started,
            errors: [err instanceof Error ? err.message : String(err)],
            warnings: [],
          },
        });
      } finally {
        clearTimeout(timer);
      }
      break;
    }

    case 'start-turn':
      await runTurn(command);
      break;

    case 'cancel':
      turnController?.abort();
      break;

    case 'resolve-confirmation': {
      const resolve = pendingConfirmations.get(command.id);
      if (resolve) {
        pendingConfirmations.delete(command.id);
        resolve(command.approved);
      }
      break;
    }

    case 'clear-key':
      apiKey = '';
      adapter = null;
      break;
  }
};

post({ type: 'ready' });
