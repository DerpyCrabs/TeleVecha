import { shareValue } from 'effectweb/share';

/** Own the notification boundary between independent sessions and the mounted app view. */
export function projectionPublication<Model>(options: {
  invalidate: () => void;
  refresh: () => void;
  project: () => Model;
  afterPublish?: () => void;
}) {
  const listeners = new Set<(model: Model) => void>();
  const subscriptions = new Set<() => void>();
  let published: Model;
  let started = false;
  let disposed = false;
  let queued = false;
  let revision = 0;

  const changed = () => {
    if (disposed) return;
    revision++;
    options.invalidate();
    if (!started || queued) return;
    queued = true;
    queueMicrotask(flush);
  };
  function flush() {
    queued = false;
    if (disposed) return;
    options.refresh();
    if (disposed) return;
    const version = revision;
    const next = shareValue(published, options.project());
    // A projection that invalidates itself must be recalculated before publication.
    if (disposed || version !== revision) return;
    if (next !== published) {
      published = next;
      const currentListeners = [...listeners];
      for (const listener of currentListeners) {
        if (disposed) break;
        if (listeners.has(listener)) listener(next);
      }
    }
    if (!disposed) options.afterPublish?.();
  }
  return {
    get disposed() {
      return disposed;
    },
    changed,
    watch(source: { subscribe: (changed: () => void) => () => void }) {
      if (disposed) return () => {};
      const unsubscribe = source.subscribe(changed);
      let active = true;
      const stop = () => {
        if (!active) return;
        active = false;
        subscriptions.delete(stop);
        unsubscribe();
      };
      if (disposed) stop();
      else subscriptions.add(stop);
      return stop;
    },
    start() {
      if (disposed || started) return;
      options.refresh();
      if (disposed) return;
      const version = revision;
      published = options.project();
      started = true;
      if (version !== revision) changed();
    },
    model(this: void) {
      if (!started) throw new Error('Start projection publication before reading its model');
      return published;
    },
    subscribe(this: void, listener: (model: Model) => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      const errors: unknown[] = [];
      for (const stop of [...subscriptions].reverse()) {
        try {
          stop();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Projection subscription cleanup failed');
    },
  };
}
