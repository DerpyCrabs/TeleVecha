import type { ImageRotation, ImageTransformPlan } from './imageTransforms';
export interface ImagePoint {
  x: number;
  y: number;
}
export interface ImageStroke {
  points: readonly ImagePoint[];
  color: string;
  width: number;
}

/** Store marks in original image coordinates so later crops/rotations keep them attached. */
export function imagePointFromPreview(
  x: number,
  y: number,
  width: number,
  height: number,
  plan: ImageTransformPlan,
  rotation: ImageRotation,
  flip: boolean,
): ImagePoint {
  const u = flip ? 1 - x : x;
  const [sx, sy] =
    rotation === 90
      ? [y, 1 - u]
      : rotation === 180
        ? [1 - u, 1 - y]
        : rotation === 270
          ? [1 - y, u]
          : [u, y];
  return {
    x: (plan.sourceX + sx * plan.sourceWidth) / width,
    y: (plan.sourceY + sy * plan.sourceHeight) / height,
  };
}
export function renderImageStrokes(
  context: CanvasRenderingContext2D,
  strokes: readonly ImageStroke[],
  width: number,
  height: number,
) {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    const first = stroke.points[0];
    if (!first) continue;
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.lineWidth = stroke.width * Math.min(width, height);
    context.beginPath();
    if (stroke.points.length === 1) {
      context.arc(first.x * width, first.y * height, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(first.x * width, first.y * height);
      for (const point of stroke.points.slice(1)) context.lineTo(point.x * width, point.y * height);
      context.stroke();
    }
  }
}
