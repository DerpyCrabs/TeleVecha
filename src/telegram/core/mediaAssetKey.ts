import type { TelegramMessage } from '../types';

export function telegramMediaAssetKey(message: TelegramMessage) {
  const media = message.media;
  const previewMedia = message.linkPreview?.media;
  const identity =
    media?.cacheKey ??
    (previewMedia?.cacheKey ? `webpage-video-v2:${previewMedia.cacheKey}` : undefined) ??
    [
      message.editedAt ?? 0,
      media?.kind ?? previewMedia?.kind ?? 'preview',
      media?.name ?? previewMedia?.name ?? message.linkPreview?.url ?? '',
      media?.mimeType ?? previewMedia?.mimeType ?? '',
      media?.size ?? previewMedia?.size ?? '',
      media?.width ?? previewMedia?.width ?? '',
      media?.height ?? previewMedia?.height ?? '',
      media?.duration ?? previewMedia?.duration ?? '',
    ].join(':');
  return `media:${message.peerId}:${message.id}:${identity}`;
}
