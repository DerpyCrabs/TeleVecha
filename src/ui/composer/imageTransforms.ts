export type CropAspect = 'original' | 'square' | '4:3' | '16:9';
export type ImageRotation = 0 | 90 | 180 | 270;

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
};

export function planImageTransform(
  width: number,
  height: number,
  rotation: ImageRotation,
  crop: CropAspect,
): ImageTransformPlan {
  if (width <= 0 || height <= 0) throw new Error('The image has invalid dimensions.');
  let sourceWidth = width;
  let sourceHeight = height;
  if (crop !== 'original') {
    const outputRatio = cropRatios[crop];
    const sourceRatio = rotation === 90 || rotation === 270 ? 1 / outputRatio : outputRatio;
    if (width / height > sourceRatio) sourceWidth = height * sourceRatio;
    else sourceHeight = width / sourceRatio;
  }
  const quarterTurn = rotation === 90 || rotation === 270;
  return {
    sourceX: (width - sourceWidth) / 2,
    sourceY: (height - sourceHeight) / 2,
    sourceWidth,
    sourceHeight,
    outputWidth: Math.max(1, Math.round(quarterTurn ? sourceHeight : sourceWidth)),
    outputHeight: Math.max(1, Math.round(quarterTurn ? sourceWidth : sourceHeight)),
  };
}

async function decodeImage(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}> {
  if ('createImageBitmap' in window) {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function outputMimeType(file: File) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/png';
}

function outputName(file: File, mimeType: string) {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : (mimeType.split('/')[1] ?? 'png');
  return file.name.replace(/(?:\.[^.]+)?$/, `.${extension}`);
}

export async function transformImageFile(
  file: File,
  rotation: ImageRotation,
  crop: CropAspect,
): Promise<File> {
  const decoded = await decodeImage(file);
  try {
    const plan = planImageTransform(decoded.width, decoded.height, rotation, crop);
    const canvas = document.createElement('canvas');
    canvas.width = plan.outputWidth;
    canvas.height = plan.outputHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image editing is unavailable in this browser.');
    if (rotation === 90) {
      context.translate(canvas.width, 0);
      context.rotate(Math.PI / 2);
    } else if (rotation === 180) {
      context.translate(canvas.width, canvas.height);
      context.rotate(Math.PI);
    } else if (rotation === 270) {
      context.translate(0, canvas.height);
      context.rotate(-Math.PI / 2);
    }
    context.drawImage(
      decoded.source,
      plan.sourceX,
      plan.sourceY,
      plan.sourceWidth,
      plan.sourceHeight,
      0,
      0,
      plan.sourceWidth,
      plan.sourceHeight,
    );
    const mimeType = outputMimeType(file);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('The edited image was empty.'))),
        mimeType,
        0.92,
      );
    });
    return new File([blob], outputName(file, mimeType), {
      type: mimeType,
      lastModified: Date.now(),
    });
  } finally {
    decoded.close();
  }
}
