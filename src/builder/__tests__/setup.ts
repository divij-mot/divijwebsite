/**
 * Test environment shims.
 *
 * Node has WebCrypto and TextEncoder already; what it lacks is IndexedDB, which
 * fake-indexeddb provides. OPFS is not shimmed at all -- the blob store falls back to its
 * in-memory implementation, which is the same code path the tests want to exercise.
 */

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
