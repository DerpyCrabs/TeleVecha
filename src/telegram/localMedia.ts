import type { TelegramMedia } from './types';

/** Photos may be renamed by Telegram; documents retain their uploaded encoding. */
export function canReuseUploadedMedia(media: TelegramMedia | undefined, blob: Blob) {
  return Boolean(
    media &&
    ((media.kind === 'photo' && blob.type.startsWith('image/')) ||
      media.mimeType === (blob.type || 'application/octet-stream')),
  );
}

/** Capture an actual decoded video frame, never use a video blob as an image URL. */
export function readVideoPreview(file: Blob, signal?: AbortSignal) {
  return new Promise<{ width: number; height: number; duration?: number; preview: Blob }>(
    (resolve, reject) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(file);
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        video.onloadeddata = null;
        video.onerror = null;
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = () => fail(new Error('Video preview was canceled.'));
      const timer = setTimeout(
        () => fail(new Error('Timed out while reading the video preview.')),
        15_000,
      );
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.onerror = () => fail(new Error('Could not decode the video preview.'));
      video.onloadeddata = () => {
        try {
          const width = video.videoWidth;
          const height = video.videoHeight;
          if (!width || !height) throw new Error('The video has invalid dimensions.');
          const duration = Number.isFinite(video.duration) ? video.duration : undefined;
          const scale = Math.min(1, 640 / Math.max(width, height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Video preview drawing is unavailable.');
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(
            (preview) => {
              if (settled) return;
              if (!preview) return fail(new Error('Could not create the video preview.'));
              settled = true;
              cleanup();
              resolve({ width, height, ...(duration === undefined ? {} : { duration }), preview });
            },
            'image/jpeg',
            0.85,
          );
        } catch (error) {
          fail(error);
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else video.src = url;
    },
  );
}
