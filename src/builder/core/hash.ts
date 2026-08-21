/**
 * Content addressing for the OPFS store.
 *
 * SHA-256 via WebCrypto. Two checkpoints that contain the same file reference the same
 * blob, which is what makes "checkpoint before every turn" affordable.
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer: a Uint8Array view over a larger pooled buffer would
  // otherwise hash the whole pool.
  const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  return toHex(await crypto.subtle.digest('SHA-256', copy));
}

export async function hashText(text: string): Promise<string> {
  return hashBytes(encoder.encode(text));
}

/**
 * Stable identity for a whole tree, used to tell whether the sandbox is in sync with
 * OPFS without diffing every file.
 */
export async function hashManifest(files: Record<string, { hash: string }>): Promise<string> {
  const lines = Object.keys(files)
    .sort()
    .map((p) => `${p}\u0000${files[p].hash}`)
    .join('\n');
  return hashText(lines);
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/** Non-cryptographic id for messages, tool events, and checkpoints. */
export function randomId(prefix = ''): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(36).padStart(2, '0');
  return prefix ? `${prefix}_${out}` : out;
}
