import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rememberAssetUrl } from './assetUrls';
import { MediaAssets } from './mediaAssets';

const assetGlobals = globalThis as typeof globalThis & {
  __televechaAssetUrls?: Map<string, string>;
  __televechaPendingAssetUrls?: Map<string, Promise<string>>;
};

function mediaSource() {
  return {
    loadCachedAvatar: vi.fn(async () => undefined),
    downloadAvatar: vi.fn(async () => new Blob(['avatar'])),
    mediaAssetKey: vi.fn(() => 'media:key'),
    downloadMedia: vi.fn(async () => new Blob(['media'])),
    downloadSticker: vi.fn(async () => new Blob(['sticker'])),
    downloadCustomEmoji: vi.fn(async () => new Blob(['emoji'])),
  };
}

describe('MediaAssets cache lifecycle', () => {
  beforeEach(() => {
    delete assetGlobals.__televechaAssetUrls;
    delete assetGlobals.__televechaPendingAssetUrls;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bounds avatar object URLs while browsing a large dialog list', async () => {
    let sequence = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:avatar-${++sequence}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const assets = new MediaAssets(mediaSource(), () => []);

    for (let index = 0; index < 300; index += 1) {
      await assets.loadPeerAvatar({ id: `u:${index}`, kind: 'user' }, true, `avatar-${index}`);
    }

    expect(revoke).toHaveBeenCalledTimes(44);
    assets.dispose();
  });

  it('revokes message and sticker object URLs when the cache is cleared', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:message');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const assets = new MediaAssets(mediaSource(), () => []);
    rememberAssetUrl('message:1', new Blob(['message']));

    assets.dispose();

    expect(revoke).toHaveBeenCalledWith('blob:message');
  });
});
