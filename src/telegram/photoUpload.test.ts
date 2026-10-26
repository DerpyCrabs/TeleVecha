import { Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { preparePhotoUpload } from './photoUpload';

afterEach(() => vi.unstubAllGlobals());

it('normalizes an oversized PNG and releases its decoded bitmap', async () => {
  const bitmap = { width: 6000, height: 4000, close: vi.fn() };
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: vi.fn((done: (blob: Blob) => void) => done(new Blob(['jpeg'], { type: 'image/jpeg' }))),
  };
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
  vi.stubGlobal('document', { createElement: () => canvas });
  const file = new File([new Uint8Array(14_332_434)], 'photo.png', { type: 'image/png' });
  const result = await Effect.runPromise(preparePhotoUpload(file));
  expect([canvas.width, canvas.height]).toEqual([2560, 1707]);
  expect([result?.name, result?.type, result?.size]).toEqual(['photo.jpg', 'image/jpeg', 4]);
  expect(bitmap.close).toHaveBeenCalledOnce();
});

it('preserves an already suitable JPEG', async () => {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 800, height: 600, close }));
  const file = new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' });
  expect(await Effect.runPromise(preparePhotoUpload(file))).toBe(file);
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  [6000, 100],
  [100, 6000],
])('falls back to a document for %s × %s images and releases the bitmap', async (width, height) => {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width, height, close }));
  await expect(
    Effect.runPromise(preparePhotoUpload(new File(['png'], 'wide.png'))),
  ).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
});
