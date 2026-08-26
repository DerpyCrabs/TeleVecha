import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireSingleTabLease, TabLockUnsupportedError } from './tabLock';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('acquireSingleTabLease', () => {
  it('fails closed when Web Locks are unavailable in a browser', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});

    await expect(acquireSingleTabLease()).rejects.toThrow(TabLockUnsupportedError);
    await expect(acquireSingleTabLease()).rejects.toThrow('safe single-tab sync');
  });

  it('uses a no-op lease outside a browser where multiple tabs cannot exist', async () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('navigator', undefined);

    const lease = await acquireSingleTabLease();
    expect(lease).toBeDefined();
    expect(() => lease?.release()).not.toThrow();
  });

  it('shares one document lease and releases the browser lock after the last reference', async () => {
    const browserWindow: {
      __televechaTabLease?: unknown;
      __televechaTabLeasePending?: unknown;
    } = {};
    let browserLockReleased = false;
    const request = vi.fn(
      async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => {
        await callback({});
        browserLockReleased = true;
      },
    );
    vi.stubGlobal('window', browserWindow);
    vi.stubGlobal('navigator', { locks: { request } });

    const first = await acquireSingleTabLease();
    const second = await acquireSingleTabLease();
    expect(request).toHaveBeenCalledTimes(1);

    first?.release();
    await Promise.resolve();
    expect(browserLockReleased).toBe(false);
    second?.release();
    await vi.waitFor(() => expect(browserLockReleased).toBe(true));

    const third = await acquireSingleTabLease();
    expect(request).toHaveBeenCalledTimes(2);
    third?.release();
  });

  it('returns no lease after another tab rejects both lock attempts', async () => {
    const request = vi.fn(
      async (_name: string, _options: unknown, callback: (lock: undefined) => Promise<void>) =>
        callback(undefined),
    );
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { locks: { request } });

    await expect(acquireSingleTabLease()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('surfaces Web Locks API failures instead of misreporting another tab', async () => {
    const request = vi.fn().mockRejectedValue(new Error('locks disabled'));
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { locks: { request } });

    const acquisition = acquireSingleTabLease();
    await expect(acquisition).rejects.toThrow(TabLockUnsupportedError);
    await expect(acquisition).rejects.toThrow('locks disabled');
    expect(request).toHaveBeenCalledOnce();
  });
});
