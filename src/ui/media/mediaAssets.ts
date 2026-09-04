import { Effect } from 'effect';

import type { EffectMessagingClient } from '../../telegram/core/client';
import type { MessagingError } from '../../telegram/core/messagingError';
import type {
  TelegramDialog,
  TelegramMessage,
  TelegramPeer,
  TelegramSticker,
  TelegramTransferProgress,
} from '../../telegram/types';
import { cachedAssetUrl, clearAssetUrls, loadAssetUrl, rememberAssetUrl } from './assetUrls';
import type { UiEffectRunner, UiSharedEffectRunner } from '../app/appRuntime';

const MAX_AVATAR_URLS = 256;

export interface MediaAsset {
  readonly revision: string;
  cached(): string | undefined;
  load(progress?: TelegramTransferProgress): Promise<string>;
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
  runEffect: UiEffectRunner,
  runSharedEffect: UiSharedEffectRunner,
  dialogs: () => TelegramDialog[],
) {
  const customEmojiAssets = new Map<string, { url: string; mimeType: string }>();
  const avatarUrls = new Map<string, string>();
  const activeLoadKeys = new Set<string>();

  const loadPeerAvatar = (
    peer: TelegramPeer,
    hasAvatar: boolean,
    avatarId: string | undefined,
    cachedOnly = false,
  ) => {
    if (!hasAvatar) return runEffect(Effect.succeed(undefined));
    const key = `${peer.id}:${avatarId ?? 'unknown'}`;
    const cached = avatarUrls.get(key);
    if (cached) {
      avatarUrls.delete(key);
      avatarUrls.set(key, cached);
      return runEffect(Effect.succeed(cached));
    }
    const loadKey = `media:avatar:${key}`;
    activeLoadKeys.add(loadKey);
    return runSharedEffect(
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
  };

  const asset = (
    revision: string,
    load: (progress?: TelegramTransferProgress) => Effect.Effect<Blob, MessagingError>,
  ): MediaAsset => {
    return {
      revision,
      cached: () => cachedAssetUrl(revision),
      load: (progress) => {
        const loadKey = `media:asset:${revision}`;
        activeLoadKeys.add(loadKey);
        return runSharedEffect(
          loadKey,
          loadAssetUrl(revision, () => load(progress)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                activeLoadKeys.delete(loadKey);
              }),
            ),
          ),
        );
      },
    };
  };

  const message = (value: TelegramMessage) =>
    asset(engine.mediaAssetKey(value), (progress) =>
      progress ? engine.downloadMedia(value, { progress }) : engine.downloadMedia(value),
    );
  const sticker = (value: TelegramSticker) =>
    asset(`sticker:${value.id}`, () => engine.downloadSticker(value));

  return {
    loadPeerAvatar,
    loadAvatar(peerId: string, cachedOnly = false) {
      const dialog = dialogs().find(({ peer }) => peer.id === peerId);
      return dialog
        ? loadPeerAvatar(dialog.peer, dialog.hasAvatar, dialog.avatarId, cachedOnly)
        : runEffect(Effect.succeed(undefined));
    },
    avatarIdentity(peerId: string) {
      const dialog = dialogs().find(({ peer }) => peer.id === peerId);
      return `${peerId}:${dialog?.avatarId ?? 'none'}`;
    },
    message,
    messagePreview(value: TelegramMessage) {
      const revision = `preview:${engine.mediaAssetKey(value)}`;
      return asset(revision, () => engine.downloadMedia(value, { preview: true }));
    },
    pending: (peerId: string, messageId: string, blob: Blob) =>
      asset(`pending-media:${peerId}:${messageId}`, () => Effect.succeed(blob)),
    sticker,
    loadMedia: (value: TelegramMessage, progress?: TelegramTransferProgress) =>
      message(value).load(progress),
    loadSticker: (value: TelegramSticker) => sticker(value).load(),
    loadCustomEmoji(documentId: string) {
      const assetKey = `custom-emoji:${documentId}`;
      const current = customEmojiAssets.get(documentId);
      if (current && cachedAssetUrl(assetKey)) return runEffect(Effect.succeed(current));
      customEmojiAssets.delete(documentId);
      const loadKey = `media:emoji:${documentId}`;
      activeLoadKeys.add(loadKey);
      return runSharedEffect(
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
    },
    dispose() {
      for (const url of avatarUrls.values()) URL.revokeObjectURL(url);
      avatarUrls.clear();
      for (const key of activeLoadKeys) void runSharedEffect.cancel(key);
      activeLoadKeys.clear();
      customEmojiAssets.clear();
      clearAssetUrls();
    },
  };
}

export type MediaAssets = ReturnType<typeof createMediaAssets>;
