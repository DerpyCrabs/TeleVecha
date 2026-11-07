import { Effect } from 'effect';
import { renderImageStrokes, type ImageStroke } from './imageDrawing';

export type CropAspect = 'original' | 'square' | '4:3' | '16:9' | '3:4' | '9:16';
export type ImageRotation = 0 | 90 | 180 | 270;

export interface ImageAdjustments {
  zoom: number;
  positionX: number;
  positionY: number;
  flip: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
}
export const defaultImageAdjustments: ImageAdjustments = {
  zoom: 1,
  positionX: 0.5,
  positionY: 0.5,
  flip: false,
  brightness: 100,
  contrast: 100,
  saturation: 100,
};

export interface ImageTransformPlan {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
}

const cropRatios: Record<Exclude<CropAspect, 'original'>, number> = {
  square: 1,
  '4:3': 4 / 3,
  '16:9': 16 / 9,
  '3:4': 3 / 4,
  '9:16': 9 / 16,
};

export function planImageTransform(
  width: number,
  height: number,
  rotation: ImageRotation,
  crop: CropAspect,
  adjustments: ImageAdjustments = defaultImageAdjustments,
): ImageTransformPlan {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error('The image has invalid dimensions.');
  let sourceWidth = width;
  let sourceHeight = height;
  if (crop !== 'original') {
    const outputRatio = cropRatios[crop];
    const sourceRatio = rotation === 90 || rotation === 270 ? 1 / outputRatio : outputRatio;
    if (width / height > sourceRatio) sourceWidth = height * sourceRatio;
    else sourceHeight = width / sourceRatio;
  }
  const zoom = Math.min(4, Math.max(1, adjustments.zoom));
  sourceWidth /= zoom;
  sourceHeight /= zoom;
  const quarterTurn = rotation === 90 || rotation === 270;
  return {
    sourceX: (width - sourceWidth) * Math.max(0, Math.min(1, adjustments.positionX)),
    sourceY: (height - sourceHeight) * Math.max(0, Math.min(1, adjustments.positionY)),
    sourceWidth,
    sourceHeight,
    outputWidth: Math.max(1, Math.round(quarterTurn ? sourceHeight : sourceWidth)),
    outputHeight: Math.max(1, Math.round(quarterTurn ? sourceWidth : sourceHeight)),
  };
}

const decodeImage = (file: File) =>
  Effect.gen(function* () {
    if (yield* Effect.try({ try: () => 'createImageBitmap' in window, catch: (error) => error })) {
      const resource = yield* Effect.acquireRelease(
        Effect.sync(() => ({ closed: false, bitmap: undefined as ImageBitmap | undefined })),
        (value) =>
          Effect.sync(() => {
            value.closed = true;
            value.bitmap?.close();
          }),
      );
      const bitmap = yield* Effect.tryPromise({
        try: () =>
          createImageBitmap(file).then((value) => {
            if (resource.closed) value.close();
            else resource.bitmap = value;
            return value;
          }),
        catch: (error) => error,
      });
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    }
    const url = yield* Effect.acquireRelease(
      Effect.try({ try: () => URL.createObjectURL(file), catch: (error) => error }),
      (value) => Effect.sync(() => URL.revokeObjectURL(value)),
    );
    const image = yield* Effect.try({
      try: () => {
        const value = new Image();
        value.src = url;
        return value;
      },
      catch: (error) => error,
    });
    yield* Effect.tryPromise({ try: () => image.decode(), catch: (error) => error });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight };
  });

function outputMimeType(file: File) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/png';
}

export const readImageDimensions = (file: File) =>
  Effect.scoped(decodeImage(file).pipe(Effect.map(({ width, height }) => ({ width, height }))));

function outputName(file: File, mimeType: string) {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : (mimeType.split('/')[1] ?? 'png');
  return file.name.replace(/(?:\.[^.]+)?$/, `.${extension}`);
}

export function renderImageTransform(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  width: number,
  height: number,
  rotation: ImageRotation,
  crop: CropAspect,
  adjustments: ImageAdjustments = defaultImageAdjustments,
  maxSize = Infinity,
  strokes: readonly ImageStroke[] = [],
) {
  const plan = planImageTransform(width, height, rotation, crop, adjustments);
  const scale = Math.min(1, maxSize / Math.max(plan.outputWidth, plan.outputHeight));
  canvas.width = Math.max(1, Math.round(plan.outputWidth * scale));
  canvas.height = Math.max(1, Math.round(plan.outputHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image editing is unavailable in this browser.');
  context.filter = `brightness(${adjustments.brightness}%) contrast(${adjustments.contrast}%) saturate(${adjustments.saturation}%)`;
  context.scale(canvas.width / plan.outputWidth, canvas.height / plan.outputHeight);
  if (adjustments.flip) {
    context.translate(plan.outputWidth, 0);
    context.scale(-1, 1);
  }
  if (rotation === 90) {
    context.translate(plan.outputWidth, 0);
    context.rotate(Math.PI / 2);
  } else if (rotation === 180) {
    context.translate(plan.outputWidth, plan.outputHeight);
    context.rotate(Math.PI);
  } else if (rotation === 270) {
    context.translate(0, plan.outputHeight);
    context.rotate(-Math.PI / 2);
  }
  const quarterTurn = rotation === 90 || rotation === 270;
  context.drawImage(
    source,
    plan.sourceX,
    plan.sourceY,
    plan.sourceWidth,
    plan.sourceHeight,
    0,
    0,
    quarterTurn ? plan.outputHeight : plan.outputWidth,
    quarterTurn ? plan.outputWidth : plan.outputHeight,
  );
  context.filter = 'none';
  context.scale(
    (quarterTurn ? plan.outputHeight : plan.outputWidth) / plan.sourceWidth,
    (quarterTurn ? plan.outputWidth : plan.outputHeight) / plan.sourceHeight,
  );
  context.translate(-plan.sourceX, -plan.sourceY);
  renderImageStrokes(context, strokes, width, height);
}

export function transformImageFile(
  file: File,
  rotation: ImageRotation,
  crop: CropAspect,
  adjustments: ImageAdjustments = defaultImageAdjustments,
  strokes: readonly ImageStroke[] = [],
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const decoded = yield* decodeImage(file);
      const canvas = yield* Effect.try({
        try: () => {
          const canvas = document.createElement('canvas');
          renderImageTransform(
            canvas,
            decoded.source,
            decoded.width,
            decoded.height,
            rotation,
            crop,
            adjustments,
            Infinity,
            strokes,
          );
          return canvas;
        },
        catch: (error) => error,
      });
      const mimeType = outputMimeType(file);
      const blob = yield* Effect.callback<Blob, unknown>((resume) => {
        try {
          canvas.toBlob(
            (value) =>
              resume(
                value
                  ? Effect.succeed(value)
                  : Effect.fail(new Error('The edited image was empty.')),
              ),
            mimeType,
            0.92,
          );
        } catch (error) {
          resume(Effect.fail(error));
        }
      });
      return new File([blob], outputName(file, mimeType), {
        type: mimeType,
        lastModified: Date.now(),
      });
    }),
  );
}
