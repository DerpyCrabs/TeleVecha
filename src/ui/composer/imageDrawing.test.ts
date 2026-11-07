import { expect, it } from 'vitest';
import { imagePointFromPreview } from './imageDrawing';
import { defaultImageAdjustments, planImageTransform, type ImageRotation } from './imageTransforms';
import {
  changeImageEdit,
  imageEditHistory,
  redoImageEdit,
  undoImageEdit,
} from './imageEditHistory';

it.each([0, 90, 180, 270] as ImageRotation[])(
  'maps drawing back to the source after rotation %s and mirroring',
  (rotation) => {
    const adjustments = { ...defaultImageAdjustments, zoom: 2, positionX: 0.2, positionY: 0.7 };
    const plan = planImageTransform(1200, 800, rotation, 'square', adjustments);
    const x = 0.25,
      y = 0.75;
    const [u, v] =
      rotation === 90
        ? [1 - y, x]
        : rotation === 180
          ? [1 - x, 1 - y]
          : rotation === 270
            ? [y, 1 - x]
            : [x, y];
    for (const flip of [false, true]) {
      const point = imagePointFromPreview(flip ? 1 - u : u, v, 1200, 800, plan, rotation, flip);
      expect(point.x).toBeCloseTo((plan.sourceX + x * plan.sourceWidth) / 1200);
      expect(point.y).toBeCloseTo((plan.sourceY + y * plan.sourceHeight) / 800);
    }
  },
);
it('undoes a stroke without losing image adjustments and restores it on redo', () => {
  let history = imageEditHistory();
  history = changeImageEdit(history, { ...history.present, rotation: 90 });
  const stroke = {
    color: '#ff0000',
    width: 0.01,
    points: [
      { x: 0.2, y: 0.3 },
      { x: 0.4, y: 0.5 },
    ],
  };
  history = changeImageEdit(history, { ...history.present, strokes: [stroke] });
  history = undoImageEdit(history);
  expect(history.present.rotation).toBe(90);
  expect(history.present.strokes).toEqual([]);
  expect(redoImageEdit(history).present.strokes).toEqual([stroke]);
});
