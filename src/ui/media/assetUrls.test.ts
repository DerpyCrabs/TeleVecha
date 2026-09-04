import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import { cachedAssetUrl, clearAssetUrls, loadAssetUrl, rememberAssetUrl } from './assetUrls';

describe('asset URL loading', () => {
  beforeEach(() => {
    clearAssetUrls();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearAssetUrls();
  });

  it('reuses the cached object URL without loading the asset again', async () => {
    const load = vi.fn(() => Effect.succeed(new Blob(['asset'])));
    const first = await Effect.runPromise(loadAssetUrl('test:cached', load));
    const second = await Effect.runPromise(loadAssetUrl('test:cached', load));

    expect(load).toHaveBeenCalledOnce();
    expect(first).toBe(second);
    expect(cachedAssetUrl('test:cached')).toBe(first);
  });

  it('does not cache a failed load', async () => {
    const load = vi
      .fn<() => Effect.Effect<Blob, Error>>()
      .mockReturnValueOnce(Effect.fail(new Error('failed')))
      .mockReturnValueOnce(Effect.succeed(new Blob(['retry'])));

    await expect(Effect.runPromise(loadAssetUrl('test:retry', load))).rejects.toThrow('failed');
    await expect(Effect.runPromise(loadAssetUrl('test:retry', load))).resolves.toMatch(/^blob:/u);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not revoke a newly allocated URL when every cached URL is mounted', () => {
    class FakeImage {
      constructor(readonly src: string) {}
    }
    const mounted = Array.from({ length: 256 }, (_, index) => new FakeImage(`blob:old-${index}`));
    vi.stubGlobal('HTMLImageElement', FakeImage);
    vi.stubGlobal('HTMLVideoElement', class FakeVideo {});
    vi.stubGlobal('HTMLAnchorElement', class FakeAnchor {});
    vi.stubGlobal('document', { querySelectorAll: () => mounted });
    let sequence = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() =>
      sequence < 256 ? `blob:old-${sequence++}` : 'blob:new',
    );
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    for (let index = 0; index < 256; index += 1) {
      rememberAssetUrl(`old:${index}`, new Blob([String(index)]));
    }

    expect(rememberAssetUrl('new', new Blob(['new']))).toBe('blob:new');
    expect(cachedAssetUrl('new')).toBe('blob:new');
    expect(revoke).not.toHaveBeenCalledWith('blob:new');
  });

  it('does not revoke a media URL that is mounted in an audio element', () => {
    class FakeAudio {
      constructor(readonly src: string) {}
    }
    const mountedAudio = new FakeAudio('blob:voice');
    vi.stubGlobal('HTMLImageElement', class FakeImage {});
    vi.stubGlobal('HTMLVideoElement', class FakeVideo {});
    vi.stubGlobal('HTMLAudioElement', FakeAudio);
    vi.stubGlobal('HTMLAnchorElement', class FakeAnchor {});
    vi.stubGlobal('document', { querySelectorAll: () => [mountedAudio] });
    let sequence = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() =>
      sequence++ === 0 ? 'blob:voice' : `blob:old-${sequence}`,
    );
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    rememberAssetUrl('voice', new Blob(['voice']));
    for (let index = 0; index < 256; index += 1) {
      rememberAssetUrl(`old:${index}`, new Blob([String(index)]));
    }

    rememberAssetUrl('new', new Blob(['new']));

    expect(revoke).not.toHaveBeenCalledWith('blob:voice');
    expect(cachedAssetUrl('voice')).toBe('blob:voice');
  });
});
