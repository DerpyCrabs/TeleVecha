import { imagePointFromPreview, type ImageStroke } from './imageDrawing';
import { domBinding } from 'effectweb';
import {
  planImageTransform,
  renderImageTransform,
  type CropAspect,
  type ImageAdjustments,
  type ImageRotation,
} from './imageTransforms';

interface PreviewInput {
  file: File;
  rotation: ImageRotation;
  crop: CropAspect;
  adjustments: ImageAdjustments;
  drawing?: { color: string; width: number } | undefined;
  strokes?: readonly ImageStroke[];
  stroke?: (stroke: ImageStroke) => void;
  move: (positionX: number, positionY: number) => void;
  error: (message: string) => void;
  gesture?: (begin: boolean) => void;
}

function acquirePreview(canvas: HTMLCanvasElement, input: () => PreviewInput) {
  const image = new Image();
  const url = URL.createObjectURL(input().file);
  let painting: { id: number; stroke: ImageStroke } | undefined;
  let ready = false;
  let disposed = false;
  let drag: { id: number; x: number; y: number; positionX: number; positionY: number } | undefined;
  const draw = () => {
    if (!ready || disposed) return;
    const value = input();
    try {
      renderImageTransform(
        canvas,
        image,
        image.naturalWidth,
        image.naturalHeight,
        value.rotation,
        value.crop,
        value.adjustments,
        1600,
        [...(value.strokes ?? []), ...(painting ? [painting.stroke] : [])],
      );
    } catch (error) {
      value.error(error instanceof Error ? error.message : 'Could not preview this image.');
    }
  };
  image.onload = () => {
    ready = true;
    draw();
  };
  image.onerror = () => input().error('Could not load this image.');
  image.src = url;
  const point = (event: PointerEvent) => {
    const value = input();
    const bounds = canvas.getBoundingClientRect();
    return imagePointFromPreview(
      (event.clientX - bounds.left) / bounds.width,
      (event.clientY - bounds.top) / bounds.height,
      image.naturalWidth,
      image.naturalHeight,
      planImageTransform(
        image.naturalWidth,
        image.naturalHeight,
        value.rotation,
        value.crop,
        value.adjustments,
      ),
      value.rotation,
      value.adjustments.flip,
    );
  };
  const down = (event: PointerEvent) => {
    if (!ready || event.button !== 0) return;
    const { adjustments, drawing } = input();
    if (drawing) {
      if (painting) return;
      painting = { id: event.pointerId, stroke: { ...drawing, points: [point(event)] } };
      canvas.setPointerCapture(event.pointerId);
      canvas.focus();
      event.preventDefault();
      draw();
      return;
    }
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      positionX: adjustments.positionX,
      positionY: adjustments.positionY,
    };
    input().gesture?.(true);
    canvas.setPointerCapture(event.pointerId);
    canvas.focus();
    event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    if (painting && event.pointerId === painting.id) {
      const samples = event.getCoalescedEvents?.() ?? [];
      painting.stroke = {
        ...painting.stroke,
        points: [...painting.stroke.points, ...(samples.length ? samples : [event]).map(point)],
      };
      draw();
      return;
    }
    if (!drag || event.pointerId !== drag.id) return;
    const value = input();
    const plan = planImageTransform(
      image.naturalWidth,
      image.naturalHeight,
      value.rotation,
      value.crop,
      value.adjustments,
    );
    const bounds = canvas.getBoundingClientRect();
    const quarter = value.rotation === 90 || value.rotation === 270;
    const dx =
      ((event.clientX - drag.x) / bounds.width) *
      (quarter ? plan.sourceHeight : plan.sourceWidth) *
      (value.adjustments.flip ? -1 : 1);
    const dy =
      ((event.clientY - drag.y) / bounds.height) * (quarter ? plan.sourceWidth : plan.sourceHeight);
    const [sx, sy] =
      value.rotation === 90
        ? [dy, -dx]
        : value.rotation === 180
          ? [-dx, -dy]
          : value.rotation === 270
            ? [-dy, dx]
            : [dx, dy];
    const rangeX = image.naturalWidth - plan.sourceWidth;
    const rangeY = image.naturalHeight - plan.sourceHeight;
    value.move(
      rangeX > 0 ? Math.max(0, Math.min(1, drag.positionX - sx / rangeX)) : 0.5,
      rangeY > 0 ? Math.max(0, Math.min(1, drag.positionY - sy / rangeY)) : 0.5,
    );
  };
  const up = (event: PointerEvent) => {
    if (painting && event.pointerId === painting.id) {
      const stroke = painting.stroke;
      painting = undefined;
      if (event.type !== 'pointercancel') input().stroke?.(stroke);
      draw();
    }
    if (drag) input().gesture?.(false);
    drag = undefined;
  };
  const key = (event: KeyboardEvent) => {
    if (input().drawing) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const value = input();
    const step = event.shiftKey ? 0.1 : 0.02;
    let dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (value.adjustments.flip) dx = -dx;
    const [sx, sy] =
      value.rotation === 90
        ? [dy, -dx]
        : value.rotation === 180
          ? [-dx, -dy]
          : value.rotation === 270
            ? [-dy, dx]
            : [dx, dy];
    value.move(
      Math.max(0, Math.min(1, value.adjustments.positionX + sx)),
      Math.max(0, Math.min(1, value.adjustments.positionY + sy)),
    );
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('lostpointercapture', up);
  canvas.addEventListener('keydown', key);
  return {
    update: draw,
    dispose() {
      disposed = true;
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(url);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('lostpointercapture', up);
      canvas.removeEventListener('keydown', key);
    },
  };
}

export const imageEditorPreview = (input: PreviewInput) => ({
  ...domBinding(input, acquirePreview),
  identity: input.file,
});
