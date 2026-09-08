import { expect, it, vi } from 'vitest';
import { projectionPublication } from './projectionPublication';

it('batches subscribed changes and shares unchanged publications', async () => {
  let value = 1;
  let notify = () => {};
  const unsubscribe = vi.fn();
  const invalidate = vi.fn();
  const refresh = vi.fn();
  const publication = projectionPublication({ invalidate, refresh, project: () => ({ value }) });
  publication.watch({
    subscribe: (changed) => {
      notify = changed;
      return unsubscribe;
    },
  });
  notify();
  publication.start();
  const initial = publication.model();
  const listener = vi.fn();
  publication.subscribe(listener);
  notify();
  notify();
  await Promise.resolve();
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(publication.model()).toBe(initial);
  expect(listener).not.toHaveBeenCalled();
  value = 2;
  notify();
  notify();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledExactlyOnceWith({ value: 2 });
  publication.dispose();
  publication.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
  notify();
  expect(invalidate).toHaveBeenCalledTimes(5);
});

it('retains changes during refresh and reentrant subscriber updates', async () => {
  let value = 0;
  let changeDuringRefresh = false;
  const publication = projectionPublication({
    invalidate: () => {},
    refresh: () => {
      if (changeDuringRefresh) {
        changeDuringRefresh = false;
        value = 2;
        publication.changed();
      }
    },
    project: () => ({ value }),
  });
  publication.start();
  const seen: number[] = [];
  publication.subscribe(({ value: next }) => {
    seen.push(next);
    if (next === 2) {
      value = 3;
      publication.changed();
    }
  });
  changeDuringRefresh = true;
  value = 1;
  publication.changed();
  await Promise.resolve();
  await Promise.resolve();
  expect(seen).toEqual([2, 3]);
  expect(publication.model()).toEqual({ value: 3 });
  publication.dispose();
});

it('does not publish a projection invalidated while it is calculated', async () => {
  let value = 0;
  let changeDuringProject = false;
  const publication = projectionPublication({
    invalidate: () => {},
    refresh: () => {},
    project: () => {
      const before = value;
      if (changeDuringProject) {
        changeDuringProject = false;
        value = 2;
        publication.changed();
      }
      return { value: before };
    },
  });
  publication.start();
  const listener = vi.fn();
  publication.subscribe(listener);
  value = 1;
  changeDuringProject = true;
  publication.changed();
  await Promise.resolve();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledExactlyOnceWith({ value: 2 });
  publication.dispose();
});

it('cancels pending publication and detaches all subscriptions on disposal', async () => {
  const refresh = vi.fn();
  const publication = projectionPublication({ invalidate: () => {}, refresh, project: () => ({}) });
  const stopped = vi.fn();
  publication.watch({ subscribe: () => stopped });
  publication.start();
  publication.changed();
  publication.dispose();
  await Promise.resolve();
  expect(refresh).toHaveBeenCalledOnce();
  expect(stopped).toHaveBeenCalledOnce();
  const late = vi.fn();
  publication.watch({ subscribe: late });
  expect(late).not.toHaveBeenCalled();
});

it('stops notifying after a listener disposes the publication', async () => {
  let value = 0;
  const afterPublish = vi.fn();
  const publication = projectionPublication({
    invalidate: () => {},
    refresh: () => {},
    project: () => ({ value }),
    afterPublish,
  });
  publication.start();
  publication.subscribe(() => publication.dispose());
  const later = vi.fn();
  publication.subscribe(later);
  value = 1;
  publication.changed();
  await Promise.resolve();
  expect(later).not.toHaveBeenCalled();
  expect(afterPublish).not.toHaveBeenCalled();
});
