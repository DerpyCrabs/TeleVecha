import { Effect, Fiber } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  defaultImageAdjustments,
  planImageTransform,
  readImageDimensions,
  transformImageFile,
} from './imageTransforms';

describe('planImageTransform', () => {
  it('center-crops a landscape image to a square', () => {
    expect(planImageTransform(1200, 800, 0, 'square')).toEqual({
      sourceX: 200,
      sourceY: 0,
      sourceWidth: 800,
      sourceHeight: 800,
      outputWidth: 800,
      outputHeight: 800,
    });
  });

  it('allows selecting an off-center detail without stretching it', () => {
    expect(
      planImageTransform(1200, 800, 0, 'square', {
        ...defaultImageAdjustments,
        zoom: 2,
        positionX: 1,
        positionY: 0,
      }),
    ).toEqual({
      sourceX: 800,
      sourceY: 0,
      sourceWidth: 400,
      sourceHeight: 400,
      outputWidth: 400,
      outputHeight: 400,
    });
  });

  it('keeps portrait crops inside a rotated image', () => {
    const plan = planImageTransform(1200, 800, 90, '9:16', {
      ...defaultImageAdjustments,
      positionX: 0,
      positionY: 1,
    });
    expect(plan.outputWidth / plan.outputHeight).toBeCloseTo(9 / 16, 2);
    expect(plan.sourceY + plan.sourceHeight).toBe(800);
    expect(plan.sourceX).toBe(0);
  });

  it('uses the final orientation when cropping a rotated image', () => {
    expect(planImageTransform(1200, 800, 90, '16:9')).toEqual({
      sourceX: 375,
      sourceY: 0,
      sourceWidth: 450,
      sourceHeight: 800,
      outputWidth: 800,
      outputHeight: 450,
    });
  });

  it('swaps the output dimensions for an uncropped quarter turn', () => {
    expect(planImageTransform(640, 480, 270, 'original')).toMatchObject({
      sourceWidth: 640,
      sourceHeight: 480,
      outputWidth: 480,
      outputHeight: 640,
    });
  });
});

describe('image transform ownership', () => {
  afterEach(() => vi.unstubAllGlobals());

  const installBitmap = () => {
    const bitmap = { width: 640, height: 480, close: vi.fn() };
    const createImageBitmap = vi.fn(async () => bitmap);
    vi.stubGlobal('window', { createImageBitmap });
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    return { bitmap, createImageBitmap };
  };

  it('defers decoding until execution and releases the bitmap after reading metadata', async () => {
    const { bitmap, createImageBitmap } = installBitmap();
    const dimensions = readImageDimensions(new File(['image'], 'photo.png'));
    expect(createImageBitmap).not.toHaveBeenCalled();
    await expect(Effect.runPromise(dimensions)).resolves.toEqual({ width: 640, height: 480 });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('releases decoded resources when canceled during native canvas encoding', async () => {
    const { bitmap } = installBitmap();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn(), scale: vi.fn(), translate: vi.fn() }),
      toBlob: vi.fn(),
    };
    vi.stubGlobal('document', { createElement: () => canvas });
    const fiber = Effect.runFork(
      transformImageFile(new File(['image'], 'photo.png'), 0, 'original'),
    );
    await vi.waitFor(() => expect(canvas.toBlob).toHaveBeenCalledOnce());
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('releases a bitmap that finishes decoding after cancellation', async () => {
    const bitmap = { width: 640, height: 480, close: vi.fn() };
    let finish!: (value: typeof bitmap) => void;
    const createImageBitmap = vi.fn(
      () =>
        new Promise<typeof bitmap>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('window', { createImageBitmap });
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    const fiber = Effect.runFork(readImageDimensions(new File(['image'], 'photo.png')));
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce());
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    finish(bitmap);
    await interrupted;
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('revokes the fallback object URL when canceled during image decoding', async () => {
    const decode = vi.fn(() => new Promise<void>(() => {}));
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('window', {});
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        decode = decode;
      },
    );
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:image', revokeObjectURL });
    const fiber = Effect.runFork(readImageDimensions(new File(['image'], 'photo.png')));
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:image');
  });
});
