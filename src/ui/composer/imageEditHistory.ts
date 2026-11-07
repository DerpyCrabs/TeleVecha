import type { ImageStroke } from './imageDrawing';
import {
  defaultImageAdjustments,
  type CropAspect,
  type ImageAdjustments,
  type ImageRotation,
} from './imageTransforms';

export interface ImageEdit {
  rotation: ImageRotation;
  crop: CropAspect;
  adjustments: ImageAdjustments;
  strokes: readonly ImageStroke[];
}
export interface ImageEditHistory {
  past: ImageEdit[];
  present: ImageEdit;
  future: ImageEdit[];
  /** A continuous pointer gesture contributes a single undo entry. */
  gesture: boolean;
  recorded: boolean;
}
export const initialImageEdit = (): ImageEdit => ({
  strokes: [],
  rotation: 0,
  crop: 'original',
  adjustments: { ...defaultImageAdjustments },
});
export const imageEditHistory = (): ImageEditHistory => ({
  past: [],
  present: initialImageEdit(),
  future: [],
  gesture: false,
  recorded: false,
});
export const beginImageEdit = (history: ImageEditHistory): ImageEditHistory => ({
  ...history,
  gesture: true,
  recorded: false,
});
export const endImageEdit = (history: ImageEditHistory): ImageEditHistory => ({
  ...history,
  gesture: false,
  recorded: false,
});

export function changeImageEdit(history: ImageEditHistory, present: ImageEdit): ImageEditHistory {
  const current = history.present;
  if (
    current.rotation === present.rotation &&
    current.crop === present.crop &&
    current.strokes.length === present.strokes.length &&
    current.strokes.every((stroke, index) => stroke === present.strokes[index]) &&
    (Object.keys(current.adjustments) as (keyof ImageAdjustments)[]).every(
      (key) => current.adjustments[key] === present.adjustments[key],
    )
  )
    return history;
  return {
    ...history,
    present,
    past:
      history.gesture && history.recorded ? history.past : [...history.past, current].slice(-100),
    future: [],
    recorded: history.gesture,
  };
}
export function undoImageEdit(history: ImageEditHistory): ImageEditHistory {
  const present = history.past.at(-1);
  return present
    ? {
        past: history.past.slice(0, -1),
        present,
        future: [history.present, ...history.future],
        gesture: false,
        recorded: false,
      }
    : endImageEdit(history);
}
export function redoImageEdit(history: ImageEditHistory): ImageEditHistory {
  const present = history.future[0];
  return present
    ? {
        past: [...history.past, history.present],
        present,
        future: history.future.slice(1),
        gesture: false,
        recorded: false,
      }
    : endImageEdit(history);
}
