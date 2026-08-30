import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cachedAssetUrl, loadAssetUrl, rememberAssetUrl } from './assetUrls';

const assetGlobals = globalThis as typeof globalThis & {
  __televechaAssetUrls?: Map<string, string>;
  __televechaPendingAssetUrls?: Map<string, Promise<string>>;
};

describe('asset URL loading', () => {
  beforeEach(() => {
    delete assetGlobals.__televechaAssetUrls;
    delete assetGlobals.__televechaPendingAssetUrls;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('deduplicates concurrent loads and reuses the resulting URL', async () => {
    const load = vi.fn(async () => new Blob(['asset']));
    const [first, second] = await Promise.all([
      loadAssetUrl('test:deduplicated', load),
      loadAssetUrl('test:deduplicated', load),
    ]);

    expect(load).toHaveBeenCalledOnce();
    expect(first).toBe(second);
    await expect(loadAssetUrl('test:deduplicated', load)).resolves.toBe(first);
    expect(cachedAssetUrl('test:deduplicated')).toBe(first);
  });

  it('clears a rejected pending load so retry can succeed', async () => {
    const load = vi
      .fn<() => Promise<Blob>>()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce(new Blob(['retry']));

    await expect(loadAssetUrl('test:retry', load)).rejects.toThrow('failed');
    await expect(loadAssetUrl('test:retry', load)).resolves.toMatch(/^blob:/u);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not revoke a newly allocated URL when every cached URL is mounted', () => {
    class FakeImage {
      constructor(readonly src: string) {}
    }
    const mounted = Array.from({ length: 256 }, (_, index) => new FakeImage(`blob:old-${index}`));
    assetGlobals.__televechaAssetUrls = new Map(
      mounted.map(({ src }, index) => [`old:${index}`, src]),
    );
    vi.stubGlobal('HTMLImageElement', FakeImage);
    vi.stubGlobal('HTMLVideoElement', class FakeVideo {});
    vi.stubGlobal('HTMLAnchorElement', class FakeAnchor {});
    vi.stubGlobal('document', { querySelectorAll: () => mounted });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:new');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    expect(rememberAssetUrl('new', new Blob(['new']))).toBe('blob:new');
    expect(cachedAssetUrl('new')).toBe('blob:new');
    expect(revoke).not.toHaveBeenCalledWith('blob:new');
  });

  it('does not revoke a media URL that is mounted in an audio element', () => {
    class FakeAudio {
      constructor(readonly src: string) {}
    }
    const mountedAudio = new FakeAudio('blob:voice');
    assetGlobals.__televechaAssetUrls = new Map([
      ['voice', mountedAudio.src],
      ...Array.from({ length: 256 }, (_, index) => [`old:${index}`, `blob:old-${index}`] as const),
    ]);
    vi.stubGlobal('HTMLImageElement', class FakeImage {});
    vi.stubGlobal('HTMLVideoElement', class FakeVideo {});
    vi.stubGlobal('HTMLAudioElement', FakeAudio);
    vi.stubGlobal('HTMLAnchorElement', class FakeAnchor {});
    vi.stubGlobal('document', { querySelectorAll: () => [mountedAudio] });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:new');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    rememberAssetUrl('new', new Blob(['new']));

    expect(revoke).not.toHaveBeenCalledWith('blob:voice');
    expect(cachedAssetUrl('voice')).toBe('blob:voice');
  });
});
