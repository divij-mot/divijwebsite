/**
 * Every hard bound in the builder, in one place.
 *
 * These are duplicated in api/_lib/limits.js because the browser and the control plane
 * cannot import from each other across the Vite/Vercel boundary. The test
 * `src/builder/__tests__/limits.test.ts` fails if the two copies drift.
 */

export const ARCHIVE_LIMITS = {
  /** Refuse outright. Matches PLAN "Reject archives over 100 MB uncompressed or 10,000 files". */
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxFileCount: 10_000,
  /** Warn but proceed; Vercel Drop uploads get slow past this. */
  warnUncompressedBytes: 50 * 1024 * 1024,
  /** A single entry may not exceed this even if the archive total is fine. */
  maxEntryBytes: 25 * 1024 * 1024,
  /**
   * Zip-bomb guard. A legitimate source tree compresses maybe 5-10x; minified assets and
   * repeated whitespace can reach 100x. Beyond 200x the entry is almost certainly hostile.
   */
  maxCompressionRatio: 200,
  maxPathLength: 400,
  maxPathDepth: 40,
} as const;

export const SANDBOX_LIMITS = {
  memoryMb: 4096,
  vcpu: 2,
  ttlSeconds: 2 * 60 * 60,
  /** Mosaic caps a single files-API write at 8 MiB; stay clear of the boundary. */
  maxUploadChunkBytes: 6 * 1024 * 1024,
  devPort: 3000,
  /** Public player link. Match the sandbox so a multiplayer game is not killed at 15 minutes. */
  previewExpirySeconds: 2 * 60 * 60,
} as const;

export const TIMEOUTS_MS = {
  command: 120_000,
  install: 180_000,
  build: 300_000,
  browserAction: 60_000,
  agentTurn: 10 * 60_000,
} as const;

export const AGENT_LIMITS = {
  maxToolStepsPerTurn: 28,
  maxVerificationRetries: 2,
  /** Model-visible output cap per tool call. Truncation is always disclosed to the model. */
  maxToolOutputBytes: 200 * 1024,
  maxFilesPerRead: 20,
  /** Deleting more than this, or anything at the project root, needs user confirmation. */
  destructiveDeleteThreshold: 5,
} as const;

export const QUOTA_LIMITS = {
  sandboxesPerHour: 4,
  sandboxesPerDay: 12,
  activeSandboxesPerCode: 1,
  sessionTtlSeconds: 12 * 60 * 60,
} as const;

/**
 * Never written to OPFS exports, ZIPs, or the sandbox. Matched case-insensitively against
 * the basename and against any path segment.
 */
export const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\.(?!example$|sample$|template$)[\w.-]+$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^credentials\.json$/i,
  /^service-account.*\.json$/i,
  /^\.aws$/i,
  /^\.ssh$/i,
];

/** Excluded from both import and export: reproducible from source, or not source at all. */
export const EXCLUDED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  '.svelte-kit',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  '.pnpm-store',
  'dist',
  'build',
  'out',
  'coverage',
  '.nyc_output',
  '.DS_Store',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
];

export const BUILDER_METADATA_DIR = '.builder';
export const PROJECT_MANIFEST_PATH = `${BUILDER_METADATA_DIR}/project.json`;
export const CHAT_LOG_PATH = `${BUILDER_METADATA_DIR}/chat.jsonl`;
export const CONTEXT_PATH = `${BUILDER_METADATA_DIR}/context.md`;
export const PROJECT_SCHEMA_VERSION = 1;

/** Guest paths. The sandbox mirrors the local tree at WORKSPACE_ROOT. */
export const WORKSPACE_ROOT = '/workspace/project';
