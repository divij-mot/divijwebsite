import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node rather than jsdom: jsdom has neither OPFS nor Web Locks, so it would not model
    // the real environment any better while costing startup time. fake-indexeddb covers
    // the storage layer, the blob store falls back to its in-memory implementation, and
    // Web Locks is stubbed per-test where the behaviour actually matters.
    environment: 'node',
    include: ['src/builder/__tests__/**/*.test.ts'],
    setupFiles: ['src/builder/__tests__/setup.ts'],
    globals: false,
    testTimeout: 15_000,
  },
});
