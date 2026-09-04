import 'fake-indexeddb/auto';

import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_CUSTOM_WALLPAPER_BYTES,
  deleteCustomWallpaper,
  loadCustomWallpaper,
  loadTelegramWallpaper,
  saveCustomWallpaper,
  saveTelegramWallpaper,
} from './customWallpaperStore';

const deleteDatabase = () =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('televecha-preferences');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

describe('custom wallpaper store', () => {
  beforeEach(deleteDatabase);

  it('stores, loads, and deletes a custom wallpaper after its transaction commits', async () => {
    const file = new File(['wallpaper'], 'wallpaper.png', { type: 'image/png' });

    await Effect.runPromise(saveCustomWallpaper(file));
    const stored = await Effect.runPromise(loadCustomWallpaper);
    expect(stored).toBeInstanceOf(Blob);
    expect(await stored?.text()).toBe('wallpaper');

    await Effect.runPromise(deleteCustomWallpaper);
    await expect(Effect.runPromise(loadCustomWallpaper)).resolves.toBeUndefined();
  });

  it('keeps Telegram and custom wallpaper records independent', async () => {
    await Effect.runPromise(saveTelegramWallpaper(new Blob(['telegram'], { type: 'image/webp' })));

    await expect(Effect.runPromise(loadCustomWallpaper)).resolves.toBeUndefined();
    const telegram = await Effect.runPromise(loadTelegramWallpaper);
    expect(await telegram?.text()).toBe('telegram');
  });

  it('rejects invalid custom files with typed validation errors', async () => {
    await expect(
      Effect.runPromise(
        saveCustomWallpaper(new File(['text'], 'notes.txt', { type: 'text/plain' })),
      ),
    ).rejects.toMatchObject({ _tag: 'WallpaperValidationError' });

    await expect(
      Effect.runPromise(
        saveCustomWallpaper(
          new File([new Uint8Array(MAX_CUSTOM_WALLPAPER_BYTES + 1)], 'large.png', {
            type: 'image/png',
          }),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: 'WallpaperValidationError',
      message: 'The background image must be smaller than 12 MB.',
    });
  });

  it('maps IndexedDB failures to a typed storage error', async () => {
    const realIndexedDb = indexedDB;
    vi.stubGlobal('indexedDB', {
      open() {
        throw new Error('unavailable');
      },
    });
    try {
      await expect(Effect.runPromise(loadCustomWallpaper)).rejects.toMatchObject({
        _tag: 'WallpaperStorageError',
      });
    } finally {
      vi.stubGlobal('indexedDB', realIndexedDb);
    }
  });
});
