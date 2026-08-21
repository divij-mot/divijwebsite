/**
 * Server-side mirror of src/builder/core/limits.ts.
 *
 * The browser bundle and the Vercel functions cannot import from each other, so these
 * constants exist twice. src/builder/__tests__/limits.test.ts parses both files and fails
 * if a value drifts, which is cheaper than a shared build step for a dozen numbers.
 */

export const ARCHIVE_LIMITS = {
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxFileCount: 10_000,
  warnUncompressedBytes: 50 * 1024 * 1024,
  maxEntryBytes: 25 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPathLength: 400,
  maxPathDepth: 40,
};

export const SANDBOX_LIMITS = {
  memoryMb: 4096,
  vcpu: 2,
  ttlSeconds: 2 * 60 * 60,
  maxUploadChunkBytes: 6 * 1024 * 1024,
  devPort: 3000,
  previewExpirySeconds: 2 * 60 * 60,
};

export const TIMEOUTS_MS = {
  command: 120_000,
  install: 180_000,
  build: 300_000,
  browserAction: 60_000,
  agentTurn: 10 * 60_000,
};

export const AGENT_LIMITS = {
  maxToolStepsPerTurn: 20,
  maxVerificationRetries: 2,
  maxToolOutputBytes: 200 * 1024,
  maxFilesPerRead: 20,
  destructiveDeleteThreshold: 5,
};

export const QUOTA_LIMITS = {
  sandboxesPerHour: 4,
  sandboxesPerDay: 12,
  activeSandboxesPerCode: 1,
  sessionTtlSeconds: 12 * 60 * 60,
};

export const WORKSPACE_ROOT = '/workspace/project';

/**
 * Mosaic's synchronous exec is fronted by Cloudflare, which returns a 520 for a request
 * that runs too long. Anything above this threshold runs as a durable process and is read
 * back through the log cursor instead. Measured empirically: a ~45s exec was cut off.
 */
export const MAX_SYNCHRONOUS_EXEC_MS = 25_000;
