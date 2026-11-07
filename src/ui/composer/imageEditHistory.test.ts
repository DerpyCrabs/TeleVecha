import { expect, it } from 'vitest';
import {
  beginImageEdit,
  changeImageEdit,
  endImageEdit,
  imageEditHistory,
  initialImageEdit,
  redoImageEdit,
  undoImageEdit,
} from './imageEditHistory';

it('undoes a complete drag in one step and restores its final position on redo', () => {
  let history = beginImageEdit(imageEditHistory());
  for (const positionX of [0.4, 0.3, 0.2])
    history = changeImageEdit(history, {
      ...history.present,
      adjustments: { ...history.present.adjustments, positionX },
    });
  history = endImageEdit(history);
  expect(history.past).toHaveLength(1);
  history = undoImageEdit(history);
  expect(history.present.adjustments.positionX).toBe(0.5);
  history = redoImageEdit(history);
  expect(history.present.adjustments.positionX).toBe(0.2);
});
it('preserves redo on a no-op and discards it after a new edit', () => {
  let history = imageEditHistory();
  history = changeImageEdit(history, { ...history.present, rotation: 90 });
  history = undoImageEdit(history);
  expect(changeImageEdit(history, initialImageEdit())).toBe(history);
  history = changeImageEdit(history, { ...history.present, crop: 'square' });
  expect(history.future).toHaveLength(0);
  expect(redoImageEdit(history).present.crop).toBe('square');
});
it('allows reset to be undone and keeps separate gestures separate', () => {
  let history = imageEditHistory();
  for (const brightness of [120, 140]) {
    history = beginImageEdit(history);
    history = changeImageEdit(history, {
      ...history.present,
      adjustments: { ...history.present.adjustments, brightness },
    });
    history = endImageEdit(history);
  }
  history = changeImageEdit(history, initialImageEdit());
  history = undoImageEdit(history);
  expect(history.present.adjustments.brightness).toBe(140);
  history = undoImageEdit(history);
  expect(history.present.adjustments.brightness).toBe(120);
  history = undoImageEdit(history);
  expect(history.present.adjustments.brightness).toBe(100);
});
it('bounds retained history and ignores an empty gesture', () => {
  let history = endImageEdit(beginImageEdit(imageEditHistory()));
  expect(history.past).toHaveLength(0);
  for (let index = 0; index < 150; index++)
    history = changeImageEdit(history, { ...history.present, rotation: index % 2 ? 0 : 90 });
  expect(history.past).toHaveLength(100);
});
