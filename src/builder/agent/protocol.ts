/**
 * The message protocol between the UI thread and the Agent Worker.
 *
 * The worker owns the API key, the conversation, and the tool loop. The key is the reason
 * this boundary exists at all: it lives in worker memory, is never posted back to the UI
 * thread, and is gone the moment the tab closes. The UI can start and stop a turn and
 * render what the worker reports, but it cannot read the credential.
 */

import type {
  AgentStatus,
  ChatMessage,
  ConnectionTestResult,
  ProjectManifest,
  ProviderSettings,
  ToolEventSummary,
} from '../core/types';

// ---------------------------------------------------------------------------
// UI -> worker
// ---------------------------------------------------------------------------

export type WorkerCommand =
  | {
      type: 'configure';
      settings: ProviderSettings;
      /** Held in worker memory only. Never persisted, never echoed back. */
      apiKey: string;
    }
  | { type: 'test-connection'; settings: ProviderSettings; apiKey: string }
  | {
      type: 'start-turn';
      prompt: string;
      workspaceId: string;
      manifest: ProjectManifest;
      history: ChatMessage[];
      projectContext: string;
      fileCount: number;
      isNewProject: boolean;
    }
  | { type: 'cancel' }
  | { type: 'resolve-confirmation'; id: string; approved: boolean }
  | { type: 'clear-key' };

// ---------------------------------------------------------------------------
// Worker -> UI
// ---------------------------------------------------------------------------

export type WorkerEvent =
  | { type: 'ready' }
  | { type: 'configured'; capabilities: ProviderSettings['capabilities'] }
  | { type: 'connection-test'; result: ConnectionTestResult }
  | { type: 'status'; status: AgentStatus }
  /** Incremental assistant text for the message currently being written. */
  | { type: 'assistant-delta'; messageId: string; text: string }
  | { type: 'assistant-complete'; message: ChatMessage }
  | { type: 'tool-event'; messageId: string; event: ToolEventSummary }
  | { type: 'log'; stream: 'stdout' | 'stderr' | 'system'; text: string }
  /** Files the sandbox changed, for mirroring back into OPFS. */
  | { type: 'files-changed'; files: { path: string; contentBase64: string | null; deleted: boolean }[] }
  | { type: 'preview-invalidated' }
  | {
      type: 'confirmation-required';
      id: string;
      title: string;
      detail: string;
      kind: 'delete' | 'network' | 'env';
      payload: Record<string, unknown>;
    }
  | { type: 'turn-finished'; reason: 'done' | 'cancelled' | 'error' | 'step-limit'; summary?: string }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'sandbox-expired' };

export interface WorkerRequestEnvelope {
  id: string;
  command: WorkerCommand;
}
