/**
 * Single-writer enforcement across tabs.
 *
 * Two tabs editing the same OPFS tree would interleave writes and corrupt the manifest,
 * so the second tab to open a project gets read-only mode rather than a race. The Web
 * Locks API gives us this without a heartbeat: the lock releases automatically when the
 * holding tab is closed or crashes.
 */

export type LockState = 'writer' | 'reader' | 'unsupported';

export interface ProjectLock {
  state: LockState;
  /** Resolves when the lock is given up, either by release() or by the tab closing. */
  released: Promise<void>;
  release(): void;
}

function lockName(projectId: string): string {
  return `divij-builder:project:${projectId}`;
}

/**
 * Try to become the writer for a project.
 *
 * Returns immediately with `reader` when another tab already holds the lock, because
 * blocking would leave the second tab with a spinner and no explanation.
 */
export async function acquireProjectLock(projectId: string): Promise<ProjectLock> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return { state: 'unsupported', released: Promise.resolve(), release: () => {} };
  }

  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  // The lock is held for exactly as long as the callback runs, so the callback must not
  // return until release() is called. That means we cannot await locks.request() -- it
  // would not settle until we had already given the lock up. Instead the callback reports
  // the outcome through this promise and then parks.
  return new Promise<ProjectLock>((resolveLock) => {
    // ifAvailable makes this a try-lock: the callback receives null when another tab holds it.
    void navigator.locks.request(
      lockName(projectId),
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) {
          resolveLock({ state: 'reader', released: Promise.resolve(), release: () => {} });
          return;
        }

        // Release when the page goes away. Navigating within the tab can put the old
        // document in the back/forward cache rather than discarding it, and a bfcached
        // document keeps holding its locks -- so reloading /builder would find the
        // project "open in another tab" and drop into read-only mode against itself.
        // pagehide fires for both bfcache entry and real unload, unlike unload.
        const releaseOnHide = () => release();
        if (typeof addEventListener === 'function') {
          addEventListener('pagehide', releaseOnHide);
        }

        resolveLock({
          state: 'writer',
          released,
          release: () => {
            if (typeof removeEventListener === 'function') {
              removeEventListener('pagehide', releaseOnHide);
            }
            release();
          },
        });
        await released;
        if (typeof removeEventListener === 'function') {
          removeEventListener('pagehide', releaseOnHide);
        }
      },
    );
  });
}

/**
 * Non-destructive check for whether a project is already open elsewhere.
 * Useful for the project list, where taking the lock would be rude.
 */
export async function isProjectLocked(projectId: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.locks?.query) return false;
  const snapshot = await navigator.locks.query();
  const name = lockName(projectId);
  return (snapshot.held ?? []).some((l) => l.name === name);
}
