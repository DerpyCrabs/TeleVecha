import { describe, expect, it, vi } from 'vitest';

import { ResourceCache } from './resourceCache';

describe('ResourceCache', () => {
  it('coalesces concurrent loads and releases the request afterward', async () => {
    const cache = new ResourceCache();
    const loader = vi.fn(async () => new Blob(['media']));

    const [first, second] = await Promise.all([
      cache.load('media:1', loader),
      cache.load('media:1', loader),
    ]);

    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledOnce();
    await cache.load('media:1', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('invalidates resource versions and selected in-flight keys together', async () => {
    const cache = new ResourceCache();
    const loader = vi.fn(async () => ({ theme: 'night' }));
    await expect(cache.cached('appearance:1', loader)).resolves.toEqual({ theme: 'night' });

    cache.invalidate('message:1', 'media:old');

    expect(cache.version('message:1')).toBe(1);
    cache.forget('appearance:1');
    await cache.cached('appearance:1', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('owns cached-value reuse, including an explicit undefined value', async () => {
    const cache = new ResourceCache();
    const loader = vi.fn(async () => undefined);

    await expect(cache.cached('appearance:missing', loader)).resolves.toBeUndefined();
    await expect(cache.cached('appearance:missing', loader)).resolves.toBeUndefined();

    expect(loader).toHaveBeenCalledOnce();
  });

  it('does not let a forgotten in-flight load restore stale data', async () => {
    let resolve!: (value: string) => void;
    const stale = new Promise<string>((settle) => {
      resolve = settle;
    });
    const cache = new ResourceCache();
    const first = cache.cached('appearance:1', () => stale);

    cache.forget('appearance:1');
    resolve('stale');
    await first;

    await expect(cache.cached('appearance:1', async () => 'fresh')).resolves.toBe('fresh');
  });

  it('does not let an in-flight load repopulate the cache after clear', async () => {
    let resolve!: (value: string) => void;
    const stale = new Promise<string>((settle) => {
      resolve = settle;
    });
    const cache = new ResourceCache();
    const first = cache.cached('account-scoped', () => stale);

    cache.clear();
    resolve('old account');
    await first;

    await expect(cache.cached('account-scoped', async () => 'new account')).resolves.toBe(
      'new account',
    );
  });
});
