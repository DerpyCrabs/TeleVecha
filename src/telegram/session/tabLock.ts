export interface TabLease {
  release(): void;
}

export class TabLockUnsupportedError extends Error {
  constructor(cause?: unknown) {
    const detail = cause instanceof Error ? ` ${cause.message}` : '';
    super(`This browser cannot provide the locking required for safe single-tab sync.${detail}`);
    this.name = 'TabLockUnsupportedError';
  }
}

interface DocumentLease {
  references: number;
  releaseLock(): void;
}

declare global {
  interface Window {
    __televechaTabLease?: DocumentLease | undefined;
    __televechaTabLeasePending?: Promise<DocumentLease | undefined> | undefined;
  }
}

function referenceDocumentLease(lease: DocumentLease): TabLease {
  lease.references += 1;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      lease.references -= 1;
      if (lease.references > 0) return;
      if (window.__televechaTabLease === lease) window.__televechaTabLease = undefined;
      lease.releaseLock();
    },
  };
}

async function requestDocumentLease(): Promise<DocumentLease | undefined> {
  let releaseLock!: () => void;
  let signalAcquired!: (lease: DocumentLease | undefined) => void;
  let signalFailure!: (reason: unknown) => void;
  const acquired = new Promise<DocumentLease | undefined>((resolve, reject) => {
    signalAcquired = resolve;
    signalFailure = reject;
  });
  const held = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  const request = navigator.locks.request(
    'televecha-active-tab',
    { ifAvailable: true, mode: 'exclusive' },
    async (lock) => {
      if (!lock) {
        signalAcquired(undefined);
        return;
      }
      const lease = { references: 0, releaseLock };
      window.__televechaTabLease = lease;
      signalAcquired(lease);
      await held;
    },
  );
  void request.catch((error: unknown) => signalFailure(new TabLockUnsupportedError(error)));

  return acquired;
}

export async function acquireSingleTabLease(): Promise<TabLease | undefined> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { release() {} };
  }
  // Without an atomic browser locking primitive, allowing startup would risk two
  // tabs mutating the same IndexedDB cache and Telegram sync cursor. Fail closed.
  if (!navigator.locks) throw new TabLockUnsupportedError();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = window.__televechaTabLease;
    if (current) return referenceDocumentLease(current);

    const pending = window.__televechaTabLeasePending ?? requestDocumentLease();
    window.__televechaTabLeasePending = pending;
    let acquired: DocumentLease | undefined;
    try {
      acquired = await pending;
    } finally {
      if (window.__televechaTabLeasePending === pending) {
        window.__televechaTabLeasePending = undefined;
      }
    }
    if (acquired) return referenceDocumentLease(acquired);
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}
