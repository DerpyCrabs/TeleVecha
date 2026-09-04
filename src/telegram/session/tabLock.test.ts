import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import { acquireSingleTabLease } from './tabLock';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('acquireSingleTabLease', () => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  it('fails closed when Web Locks are unavailable in a browser', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});

    const result = await run(acquireSingleTabLease().pipe(Effect.result));
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'TabLockUnsupportedError',
        message: expect.stringContaining('safe single-tab sync'),
      },
    });
  });

  it('uses a no-op lease outside a browser where multiple tabs cannot exist', async () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('navigator', undefined);

    const lease = await run(acquireSingleTabLease());
    expect(lease).toBeDefined();
    if (lease) await run(lease.release);
  });

  it('releases the browser lock through the Effect lease', async () => {
    let browserLockReleased = false;
    const request = vi.fn(
      async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => {
        await callback({});
        browserLockReleased = true;
      },
    );
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { locks: { request } });

    const first = await run(acquireSingleTabLease());
    expect(request).toHaveBeenCalledTimes(1);

    if (first) await run(first.release);
    await vi.waitFor(() => expect(browserLockReleased).toBe(true));

    const second = await run(acquireSingleTabLease());
    expect(request).toHaveBeenCalledTimes(2);
    if (second) await run(second.release);
  });

  it('returns no lease after another tab rejects both lock attempts', async () => {
    const request = vi.fn(
      async (_name: string, _options: unknown, callback: (lock: undefined) => Promise<void>) =>
        callback(undefined),
    );
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { locks: { request } });

    await expect(run(acquireSingleTabLease())).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('surfaces Web Locks API failures instead of misreporting another tab', async () => {
    const request = vi.fn().mockRejectedValue(new Error('locks disabled'));
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { locks: { request } });

    const acquisition = await run(acquireSingleTabLease().pipe(Effect.result));
    expect(acquisition).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'TabLockUnsupportedError',
        message: expect.stringContaining('locks disabled'),
      },
    });
    expect(request).toHaveBeenCalledOnce();
  });
});
