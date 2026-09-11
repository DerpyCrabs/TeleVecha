import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import { clearAssetUrls, rememberAssetUrl } from './assetUrls';
import { createMediaAssets } from './mediaAssets';
import { telegramMediaAssetKey } from '../../telegram/core/mediaAssetKey';
import type { PendingSend, TelegramMessage } from '../../telegram/types';

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

  it.each([
    { album: false, video: false, file: false },
    { album: true, video: false, file: false },
    { album: false, video: false, file: true },
    { album: false, video: true, file: false },
    { album: true, video: true, file: false },
  ])(
    'keeps local originals and thumbnails through confirmation: %j',
    async ({ album, video, file }) => {
      const source = { ...mediaSource(), mediaAssetKey: telegramMediaAssetKey };
      const assets = createMediaAssets(source, runSharedEffect, () => []);
      const mimeType = video ? 'video/webm' : 'image/png';
      const attachments = ['landscape', ...(album ? ['portrait'] : [])].map((name) => ({
        blob: new Blob([name], { type: mimeType }),
        ...(video ? { preview: new Blob([`thumbnail:${name}`], { type: 'image/jpeg' }) } : {}),
        name: `${name}.${video ? 'webm' : 'png'}`,
        mimeType,
        sendAs: 'media' as const,
        asSticker: false,
        randomId: name,
      }));
      const pending: PendingSend = {
        id: 'pending',
        peer: { id: 'u:1', kind: 'user' },
        randomId: 'landscape',
        text: '',
        createdAt: 1,
        attempts: 0,
        ...(album ? { album: { attachments } } : { attachment: attachments[0]! }),
      };
      const confirmed: TelegramMessage[] = attachments.map((attachment, index) => ({
        id: index + 10,
        peerId: pending.peer.id,
        senderId: 'self',
        outgoing: true,
        text: '',
        date: 1,
        randomId: attachment.randomId,
        media: {
          kind: video ? 'video' : file ? 'file' : 'photo',
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.blob.size,
        },
      }));
      const urls = await Promise.all(
        attachments.map((attachment, index) =>
          Effect.runPromise(
            assets
              .pending(pending.peer.id, album ? `pending:${index}` : 'pending', attachment.blob)
              .load(),
          ),
        ),
      );
      const previews = await Promise.all(
        attachments.map((attachment, index) =>
          attachment.preview
            ? Effect.runPromise(
                assets
                  .pendingPreview(
                    pending.peer.id,
                    album ? `pending:${index}` : 'pending',
                    attachment.preview,
                  )
                  .load(),
              )
            : Promise.resolve(urls[index]),
        ),
      );

      assets.confirmUploads([pending], [...confirmed].reverse());

      for (const [index, message] of confirmed.entries()) {
        expect(assets.message(message).cached()).toBe(urls[index]);
        expect(await Effect.runPromise(assets.message(message).load())).toBe(urls[index]);
        expect(assets.messagePreview(message).cached()).toBe(previews[index]);
        expect(await Effect.runPromise(assets.messagePreview(message).load())).toBe(
          previews[index],
        );
      }
      expect(source.downloadMedia).not.toHaveBeenCalled();
      expect(new Set(urls).size).toBe(attachments.length);
      for (const message of confirmed) {
        const edited = { ...message, editedAt: 2 };
        const anotherPeer = { ...message, peerId: 'u:2' };
        assets.confirmUploads([pending], [edited, anotherPeer]);
        expect(assets.message(edited).cached()).toBeUndefined();
        expect(assets.message(anotherPeer).cached()).toBeUndefined();
        expect(assets.messagePreview(edited).cached()).toBeUndefined();
      }
    },
  );

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
