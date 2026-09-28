import { Effect } from 'effect';

import type { EffectMessagingClient } from '../../telegram/core/client';
import type { MessagingError } from '../../telegram/core/messagingError';
import type {
  TelegramDialog,
  TelegramMessage,
  TelegramPeer,
  TelegramSticker,
  TelegramTransferProgress,
  PendingSend,
} from '../../telegram/types';
import { pendingMediaForMessage } from '../../telegram/pendingMedia';
import {
  cachedAssetUrl,
  clearAssetUrls,
  loadAssetUrl,
  moveAssetUrl,
  rememberAssetUrl,
} from './assetUrls';
import type { UiSharedEffectRunner } from '../app/appRuntime';
import { createMediaStreaming } from './mediaStreaming';

const MAX_AVATAR_URLS = 256;

export interface MediaAsset {
  readonly revision: string;
  cached(): string | undefined;
  load(progress?: TelegramTransferProgress): Effect.Effect<string, MessagingError>;
  play?(): Effect.Effect<string, MessagingError>;
}

type MediaSource = Pick<
  EffectMessagingClient,
  | 'loadCachedAvatar'
  | 'downloadAvatar'
  | 'mediaAssetKey'
  | 'downloadMedia'
  | 'downloadSticker'
  | 'downloadCustomEmoji'
>;

export function createMediaAssets(
  engine: MediaSource,
  runSharedEffect: UiSharedEffectRunner,
  dialogs: () => readonly TelegramDialog[],
) {
  const customEmojiAssets = new Map<string, { url: string; mimeType: string }>();
  const avatarUrls = new Map<string, string>();
  const activeLoadKeys = new Set<string>();
  const streaming = createMediaStreaming();

  const loadPeerAvatar = (
    peer: TelegramPeer,
    hasAvatar: boolean,
    avatarId: string | undefined,
    cachedOnly: boolean = false,
  ) =>
    Effect.suspend(() => {
      if (!hasAvatar) return Effect.succeed(undefined);
      const key = `${peer.id}:${avatarId ?? 'unknown'}`;
      const cached = avatarUrls.get(key);
      if (cached) {
        avatarUrls.delete(key);
        avatarUrls.set(key, cached);
        return Effect.succeed(cached);
      }
      const loadKey = `media:avatar:${key}`;
      activeLoadKeys.add(loadKey);
      return runSharedEffect.load(
        loadKey,
        (cachedOnly
          ? engine.loadCachedAvatar(peer, avatarId)
          : engine.downloadAvatar(peer, avatarId)
        ).pipe(
          Effect.map((value) => {
            if (!value) return undefined;
            const url = URL.createObjectURL(value);
            avatarUrls.set(key, url);
            while (avatarUrls.size > MAX_AVATAR_URLS) {
              const oldest = avatarUrls.entries().next().value as [string, string] | undefined;
              if (!oldest) break;
              avatarUrls.delete(oldest[0]);
              URL.revokeObjectURL(oldest[1]);
            }
            return url;
          }),
          Effect.ensuring(
            Effect.sync(() => {
              activeLoadKeys.delete(loadKey);
            }),
          ),
        ),
      );
    });

  const asset = (
    revision: string,
    load: (progress?: TelegramTransferProgress) => Effect.Effect<Blob, MessagingError>,
  ): MediaAsset => {
    return {
      revision,
      cached: () => cachedAssetUrl(revision),
      load: (progress) =>
        Effect.suspend(() => {
          const loadKey = `media:asset:${revision}`;
          activeLoadKeys.add(loadKey);
          return runSharedEffect.load(
            loadKey,
            loadAssetUrl(revision, () => load(progress)).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  activeLoadKeys.delete(loadKey);
                }),
              ),
            ),
          );
        }),
    };
  };

  const message = (value: TelegramMessage): MediaAsset => {
    const original = asset(engine.mediaAssetKey(value), (progress) =>
      progress ? engine.downloadMedia(value, { progress }) : engine.downloadMedia(value),
    );
    const media = value.media ?? value.linkPreview?.media;
    return {
      ...original,
      play: () =>
        Effect.gen(function* () {
          const cached = original.cached();
          if (cached) return cached;
          if (media?.mimeType.startsWith('video/') && media.size) {
            const url = yield* Effect.promise(() =>
              streaming.url(original.revision, media.size!, media.mimeType, (start, end) => {
                const key = `media:range:${original.revision}:${start}-${end}`;
                activeLoadKeys.add(key);
                return runSharedEffect(
                  key,
                  engine
                    .downloadMedia(value, { range: { start, end } })
                    .pipe(Effect.ensuring(Effect.sync(() => activeLoadKeys.delete(key)))),
                );
              }),
            );
            if (url) return url;
          }
          return yield* original.load();
        }),
    };
  };
  const sticker = (value: TelegramSticker) =>
    asset(`sticker:${value.id}`, () => engine.downloadSticker(value));

  return {
    confirmUploads(pending: readonly PendingSend[], messages: readonly TelegramMessage[]) {
      if (pending.length === 0) return;
      for (const message of messages) {
        const upload = pendingMediaForMessage(pending, message);
        if (!upload) continue;
        const key = engine.mediaAssetKey(message);
        if (!moveAssetUrl(`pending-media:${message.peerId}:${upload.messageId}`, key)) {
          rememberAssetUrl(key, upload.attachment.blob);
        }
        if (
          upload.attachment.preview &&
          !moveAssetUrl(`pending-preview:${message.peerId}:${upload.messageId}`, `preview:${key}`)
        ) {
          rememberAssetUrl(`preview:${key}`, upload.attachment.preview);
        }
      }
    },
    loadPeerAvatar,
    loadAvatar(peerId: string, cachedOnly: boolean = false) {
      const dialog = dialogs().find(({ peer }) => peer.id === peerId);
      return dialog
        ? loadPeerAvatar(dialog.peer, dialog.hasAvatar, dialog.avatarId, cachedOnly)
        : Effect.succeed(undefined);
    },
    avatarIdentity(peerId: string) {
      const dialog = dialogs().find(({ peer }) => peer.id === peerId);
      return `${peerId}:${dialog?.avatarId ?? 'none'}`;
    },
    message,
    messagePreview(value: TelegramMessage) {
      const revision = `preview:${engine.mediaAssetKey(value)}`;
      const preview = asset(revision, () => engine.downloadMedia(value, { preview: true }));
      const cached = () =>
        preview.cached() ??
        (value.media?.mimeType.startsWith('image/') ? message(value).cached() : undefined);
      return {
        ...preview,
        cached,
        load: () =>
          Effect.suspend(() => {
            const url = cached();
            return url ? Effect.succeed(url) : preview.load();
          }),
      };
    },
    pendingPreview: (peerId: string, messageId: string, preview: Blob) =>
      asset(`pending-preview:${peerId}:${messageId}`, () => Effect.succeed(preview)),
    pending: (peerId: string, messageId: string, blob: Blob) =>
      asset(`pending-media:${peerId}:${messageId}`, () => Effect.succeed(blob)),
    sticker,
    loadMedia: (value: TelegramMessage, progress?: TelegramTransferProgress) =>
      message(value).load(progress),
    playMedia: (value: TelegramMessage) => message(value).play!(),
    loadSticker: (value: TelegramSticker) => sticker(value).load(),
    loadCustomEmoji: (documentId: string) =>
      Effect.suspend(() => {
        const assetKey = `custom-emoji:${documentId}`;
        const current = customEmojiAssets.get(documentId);
        if (current && cachedAssetUrl(assetKey)) return Effect.succeed(current);
        customEmojiAssets.delete(documentId);
        const loadKey = `media:emoji:${documentId}`;
        activeLoadKeys.add(loadKey);
        return runSharedEffect.load(
          loadKey,
          engine.downloadCustomEmoji(documentId).pipe(
            Effect.map((blob) => {
              const loaded = { url: rememberAssetUrl(assetKey, blob), mimeType: blob.type };
              customEmojiAssets.set(documentId, loaded);
              return loaded;
            }),
            Effect.ensuring(
              Effect.sync(() => {
                activeLoadKeys.delete(loadKey);
              }),
            ),
          ),
        );
      }),
    dispose() {
      streaming.dispose();
      for (const url of avatarUrls.values()) URL.revokeObjectURL(url);
      avatarUrls.clear();
      for (const key of activeLoadKeys) runSharedEffect.cancel(key).catch(() => undefined);
      activeLoadKeys.clear();
      customEmojiAssets.clear();
      clearAssetUrls();
    },
  };
}

export type MediaAssets = ReturnType<typeof createMediaAssets>;
