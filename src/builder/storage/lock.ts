/**
 * Single-writer enforcement across tabs.
 *
 * Two tabs editing the same OPFS tree would interleave writes and corrupt the manifest,
 * so the second tab to open a project gets read-only mode rather than a race. The Web
 * Locks API gives us this without a heartbeat: the lock releases automatically when the
 * holding tab is closed or crashes.
 *
 * "Take control" asks the holder to release over BroadcastChannel, then retries.
 */

export type LockState = 'writer' | 'reader' | 'unsupported';

export interface ProjectLock {
  state: LockState;
  /** Resolves when the lock is given up, either by release() or by the tab closing. */
  released: Promise<void>;
  /** Resolves when another tab takes the writer lock from this one. */
  stolen: Promise<void>;
  release(): void;
}

export interface AcquireLockOptions {
  steal?: boolean;
}

function lockName(projectId: string): string {
  return `divij-builder:project:${projectId}`;
}

function channelName(projectId: string): string {
  return `divij-builder:lock:${projectId}`;
}

function openChannel(projectId: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(channelName(projectId));
  } catch {
    return null;
  }
}

const idleLock = (): ProjectLock => ({
  state: 'reader',
  released: Promise.resolve(),
  stolen: new Promise(() => {}),
  release: () => {},
});

const unsupportedLock = (): ProjectLock => ({
  state: 'unsupported',
  released: Promise.resolve(),
  stolen: new Promise(() => {}),
  release: () => {},
});

/**
 * Try to become the writer for a project.
 *
 * Returns immediately with `reader` when another tab already holds the lock, because
 * blocking would leave the second tab with a spinner and no explanation. Pass `steal`
 * to take the lock from the other tab.
 */
export async function acquireProjectLock(
  projectId: string,
  options: AcquireLockOptions = {},
): Promise<ProjectLock> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return unsupportedLock();
  }

  const steal = Boolean(options.steal);
  if (steal) {
    const ping = openChannel(projectId);
    ping?.postMessage({ type: 'release' });
    try {
      ping?.close();
    } catch {
      /* already closed */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const tryOnce = (): Promise<ProjectLock> =>
    new Promise((resolveLock) => {
      void navigator.locks.request(
        lockName(projectId),
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (!lock) {
            resolveLock(idleLock());
            return;
          }

          const channel = openChannel(projectId);
          let currentState: LockState = 'writer';
          let settled = false;
          let release!: () => void;
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          let markStolen: () => void = () => {};
          const stolen = new Promise<void>((resolve) => {
            markStolen = resolve;
          });

          const finish = (reason: 'explicit' | 'stolen' | 'hide') => {
            if (settled) return;
            settled = true;
            currentState = 'reader';
            if (channel) {
              channel.onmessage = null;
              try {
                channel.close();
              } catch {
                /* already closed */
              }
            }
            if (reason === 'stolen') markStolen();
            release();
          };

          if (channel) {
            channel.onmessage = (event) => {
              if (event.data?.type === 'release') finish('stolen');
            };
          }

          const releaseOnHide = () => finish('hide');
          if (typeof addEventListener === 'function') {
            addEventListener('pagehide', releaseOnHide);
          }

          resolveLock({
            get state() {
              return currentState;
            },
            released,
            stolen,
            release: () => finish('explicit'),
          });
          await released;
          if (typeof removeEventListener === 'function') {
            removeEventListener('pagehide', releaseOnHide);
          }
        },
      );
    });

  let result = await tryOnce();
  if (result.state === 'writer' || !steal) return result;

  await new Promise((r) => setTimeout(r, 400));
  return tryOnce();
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
