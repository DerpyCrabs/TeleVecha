import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import { clearAssetUrls, rememberAssetUrl } from './assetUrls';
import { createMediaAssets } from './mediaAssets';

const runSharedEffect = Object.assign(
  <Value, Error>(_key: string, effect: Effect.Effect<Value, Error>) => Effect.runPromise(effect),
  {
    cancel: () => Effect.runPromise(Effect.void),
    load: <A, E>(_key: string, effect: Effect.Effect<A, E>) => effect,
  },
);

function mediaSource() {
  return {
    loadCachedAvatar: vi.fn(() => Effect.succeed(undefined)),
    downloadAvatar: vi.fn(() => Effect.succeed(new Blob(['avatar']))),
    mediaAssetKey: vi.fn(() => 'media:key'),
    downloadMedia: vi.fn(() => Effect.succeed(new Blob(['media']))),
    downloadSticker: vi.fn(() => Effect.succeed(new Blob(['sticker']))),
    downloadCustomEmoji: vi.fn(() => Effect.succeed(new Blob(['emoji']))),
  };
}

describe('MediaAssets cache lifecycle', () => {
  beforeEach(() => {
    clearAssetUrls();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAssetUrls();
  });

  it('bounds avatar object URLs while browsing a large dialog list', async () => {
    let sequence = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:avatar-${++sequence}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const assets = createMediaAssets(mediaSource(), runSharedEffect, () => []);

    for (let index = 0; index < 300; index += 1) {
      await Effect.runPromise(
        assets.loadPeerAvatar({ id: `u:${index}`, kind: 'user' }, true, `avatar-${index}`),
      );
    }

    expect(revoke).toHaveBeenCalledTimes(44);
    assets.dispose();
  });

  it('revokes message and sticker object URLs when the cache is cleared', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:message');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const assets = createMediaAssets(mediaSource(), runSharedEffect, () => []);
    rememberAssetUrl('message:1', new Blob(['message']));

    assets.dispose();

    expect(revoke).toHaveBeenCalledWith('blob:message');
  });
});

it('does not start avatar work until its Effect is executed', async () => {
  const engine = mediaSource();
  const assets = createMediaAssets(engine, runSharedEffect, () => []);
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:lazy-avatar');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const load = assets.loadPeerAvatar({ id: 'lazy', kind: 'user' }, true, 'photo');
  expect(engine.downloadAvatar).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(await Effect.runPromise(load)).toBe('blob:lazy-avatar');
  expect(engine.downloadAvatar).toHaveBeenCalledTimes(1);
  assets.dispose();
  create.mockRestore();
  revoke.mockRestore();
});
