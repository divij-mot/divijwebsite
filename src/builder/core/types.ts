/** Shared vocabulary for the builder: files, projects, chat, tools, and sandboxes. */

import type { PROJECT_SCHEMA_VERSION } from './limits';

// ---------------------------------------------------------------------------
// Files and projects
// ---------------------------------------------------------------------------

/** A file in the current tree. `hash` addresses its bytes in the content store. */
export interface FileEntry {
  /** Project-relative POSIX path, never leading with "/" or containing "..". */
  path: string;
  hash: string;
  size: number;
  /** Text files round-trip through UTF-8; binary files are base64 at the transport edge. */
  binary: boolean;
  modifiedAt: number;
}

export interface TreeManifest {
  projectId: string;
  files: Record<string, FileEntry>;
  updatedAt: number;
}

/**
 * A checkpoint is the manifest only. File bytes live in the content-addressed store and
 * are shared across every checkpoint that references them, so an unchanged file costs
 * nothing to snapshot again.
 */
export interface Checkpoint {
  id: string;
  projectId: string;
  createdAt: number;
  label: string;
  reason: 'pre-turn' | 'post-turn' | 'manual' | 'import';
  files: Record<string, FileEntry>;
  fileCount: number;
  totalBytes: number;
  /** Index of the chat message this checkpoint sits before or after. */
  messageIndex: number;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type Framework =
  | 'nextjs'
  | 'vite'
  | 'remix'
  | 'astro'
  | 'sveltekit'
  | 'nuxt'
  | 'create-react-app'
  | 'static'
  | 'unknown';

export interface ProjectCapabilities {
  database: boolean;
  auth: boolean;
  storage: boolean;
  payments: boolean;
}

/**
 * `.builder/project.json`. Records shape and preferences, never values or keys.
 * Re-importing a ZIP with this file restores the project exactly; without it the
 * importer falls back to detection.
 */
export interface ProjectManifest {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  name: string;
  createdAt: number;
  updatedAt: number;
  framework: Framework;
  packageManager: PackageManager;
  commands: {
    install: string;
    dev: string;
    build: string;
    typecheck?: string;
    migrate?: string;
  };
  port: number;
  /** Names only. A value here would be a leak. */
  requiredEnv: string[];
  provider?: {
    name: string;
    model: string;
    baseUrl: string;
    protocol: ProviderProtocol;
  };
  capabilities: ProjectCapabilities;
}

export interface ProjectSummary {
  id: string;
  name: string;
  framework: Framework;
  createdAt: number;
  updatedAt: number;
  fileCount: number;
  totalBytes: number;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatRole = 'user' | 'assistant' | 'system';

/**
 * A summarized record of one tool call. Deliberately lossy: arguments are trimmed and
 * output is a short human summary, because full payloads are exactly what the plan
 * forbids persisting.
 */
export interface ToolEventSummary {
  id: string;
  tool: string;
  title: string;
  status: 'running' | 'ok' | 'error' | 'denied';
  detail?: string;
  /** Paths touched, for the file-diff strip in the UI. */
  paths?: string[];
  startedAt: number;
  endedAt?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** Visible text only. Hidden reasoning is never stored. */
  content: string;
  createdAt: number;
  toolEvents?: ToolEventSummary[];
  /** Set when the turn ended early. */
  interrupted?: boolean;
  error?: string;
  checkpointId?: string;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export type ProviderProtocol = 'openai-responses' | 'openai-chat';

export type ProviderTransport = 'relay' | 'direct';

export interface ProviderPreset {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  /** Fixed server-side. The client never chooses the upstream host for a relayed preset. */
  baseUrl: string;
  transport: ProviderTransport;
  defaultModel: string;
  docsUrl?: string;
}

export interface ProviderCapabilities {
  streaming: boolean;
  functionCalling: boolean;
  vision: boolean;
}

/** Persisted locally. `apiKey` is explicitly not part of this type. */
export interface ProviderSettings {
  presetId: string;
  model: string;
  /** Only meaningful for a custom endpoint. */
  baseUrl?: string;
  protocol: ProviderProtocol;
  transport: ProviderTransport;
  capabilities?: ProviderCapabilities;
  verifiedAt?: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  capabilities: ProviderCapabilities;
  model: string;
  latencyMs: number;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Sandbox / control plane
// ---------------------------------------------------------------------------

/**
 * What `builder-init` reports about the guest it just prepared.
 *
 * `containment` is the field that matters: "enforced" means project code runs in a
 * network namespace with no default route, so the allowlisting proxy is its only path
 * out. Anything else means the sandbox came up with weaker isolation than intended and
 * the UI says so.
 */
export interface RuntimeReport {
  version: string;
  containment: 'enforced' | 'failed' | 'unknown';
  egressProxy: boolean;
  portForwarder: boolean;
  browserHelper: boolean;
}

export interface WorkspaceLease {
  /** Opaque to the browser; the control plane maps it to a Mosaic sandbox id. */
  workspaceId: string;
  expiresAt: number;
  runtime: RuntimeReport;
}

export interface PreviewInfo {
  url: string;
  expiresAt: number;
  port: number;
}

export type ToolEventKind =
  | 'start'
  | 'progress'
  | 'stdout'
  | 'stderr'
  | 'result'
  | 'error'
  | 'confirm-required';

/** One line of the NDJSON stream from POST /api/builder/workspaces/tool. */
export interface ToolStreamEvent {
  kind: ToolEventKind;
  /** Monotonic within a single tool call so the UI can order interleaved streams. */
  seq: number;
  tool: string;
  data?: unknown;
  text?: string;
  error?: string;
}

export interface SandboxFileStat {
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  size: number;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface AgentTask {
  id: string;
  title: string;
  status: 'pending' | 'active' | 'done' | 'failed';
}

export type AgentPhase =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'verifying'
  | 'done'
  | 'error'
  | 'cancelled';

export interface AgentStatus {
  phase: AgentPhase;
  step: number;
  maxSteps: number;
  tasks: AgentTask[];
  message?: string;
}

export interface LogLine {
  id: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  at: number;
}
