import { Effect } from 'effect';

// Keep ordinary photo uploads comfortably inside Telegram's photo limits.
// Documents and animated images bypass this preparation in the transport.
// Undefined means the original must be uploaded as a document instead.
export const preparePhotoUpload = (file: File) =>
  Effect.scoped(
    Effect.gen(function* () {
      const resource = yield* Effect.acquireRelease(
        Effect.sync(() => ({ closed: false, bitmap: undefined as ImageBitmap | undefined })),
        (value) =>
          Effect.sync(() => {
            value.closed = true;
            value.bitmap?.close();
          }),
      );
      const bitmap = yield* Effect.tryPromise(() =>
        createImageBitmap(file).then((bitmap) => {
          if (resource.closed) bitmap.close();
          else resource.bitmap = bitmap;
          return bitmap;
        }),
      );
      if (!bitmap.width || !bitmap.height)
        return yield* Effect.fail(new Error('The photo has invalid dimensions.'));
      if (Math.max(bitmap.width, bitmap.height) / Math.min(bitmap.width, bitmap.height) > 20)
        return undefined;
      if (
        file.type === 'image/jpeg' &&
        file.size < 10_000_000 &&
        Math.max(bitmap.width, bitmap.height) <= 2560
      )
        return file;
      const canvas = yield* Effect.try(() => {
        const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not prepare the photo. Send it as a file.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas;
      });
      const blob = yield* Effect.tryPromise(
        () =>
          new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the photo.'))),
              'image/jpeg',
              0.9,
            );
          }),
      );
      if (blob.size >= 10_000_000)
        return yield* Effect.fail(new Error('This photo is too large. Send it as a file.'));
      return new File([blob], file.name.replace(/(?:\.[^.]+)?$/, '.jpg'), {
        type: 'image/jpeg',
        lastModified: file.lastModified,
      });
    }),
  );
