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
});
