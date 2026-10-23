import type { TelegramMedia } from '../../telegram/types';

export type MediaDisplayKind = 'image' | 'video' | 'round-video' | 'voice' | 'tgs' | 'file';

export interface MediaPresentation {
  display: MediaDisplayKind;
  preview?: 'image' | 'video' | undefined;
  preload: boolean;
}

export function mediaPresentation(media: TelegramMedia): MediaPresentation {
  if (media.kind === 'photo') return { display: 'image', preview: 'image', preload: true };
  if (media.kind === 'video') return { display: 'video', preview: 'video', preload: true };
  if (media.kind === 'animation' && media.mimeType.startsWith('video/')) {
    return { display: 'video', preview: 'video', preload: true };
  }
  if (media.kind === 'round-video') return { display: 'round-video', preload: true };
  if (media.kind === 'voice') return { display: 'voice', preload: true };
  if (media.kind === 'sticker' && media.mimeType === 'application/x-tgsticker') {
    return { display: 'tgs', preload: true };
  }
  if (media.kind === 'sticker' && media.mimeType.startsWith('video/')) {
    return { display: 'video', preload: true };
  }
  if (media.kind === 'sticker') return { display: 'image', preload: true };
  return {
    display: 'file',
    ...(media.mimeType.startsWith('image/')
      ? { preview: 'image' as const }
      : media.mimeType.startsWith('video/')
        ? { preview: 'video' as const }
        : {}),
    // Telegram shows a thumbnail for image documents while keeping the document
    // filename and download affordance. Only non-visual files stay lazy.
    preload: media.mimeType.startsWith('image/'),
  };
}

export function formatMediaSize(size?: number) {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${Math.round(size / 1024)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

export function formatMediaDuration(duration?: number) {
  if (duration === undefined || !Number.isFinite(duration) || duration < 0) return '';
  const totalSeconds = Math.round(duration);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function describeMedia(media: TelegramMedia) {
  return [formatMediaSize(media.size), media.mimeType].filter(Boolean).join(' · ');
}
