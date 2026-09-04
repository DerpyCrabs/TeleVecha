import { Effect, Option } from 'effect';
import * as Atom from 'effect/unstable/reactivity/Atom';
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry';
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult';

/** Share JSON-shaped data; Blob, typed arrays and class instances retain their own identity. */
export function shareValue<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next;
  const array = Array.isArray(next);
  if (array !== Array.isArray(previous)) return next;
  if (
    !array &&
    (Object.getPrototypeOf(next) !== Object.prototype ||
      Object.getPrototypeOf(previous) !== Object.prototype)
  )
    return next;
  const old = previous as Record<string, unknown>;
  const value = next as Record<string, unknown>;
  const keys = Object.keys(value);
  let equal = keys.length === Object.keys(old).length;
  const shared: Record<string, unknown> = array ? ([] as unknown as Record<string, unknown>) : {};
  for (const key of keys) {
    shared[key] = shareValue(old[key], value[key]);
    if (!Object.hasOwn(old, key) || shared[key] !== old[key]) equal = false;
  }
  return equal ? previous : (shared as T);
}

/** Each observed field is an independent atom, rather than a selector of one root atom. */
export function makeRecord<T extends object>(registry: AtomRegistry.AtomRegistry, initial: T) {
  let current = initial;
  const fields = new Map<keyof T, Atom.Writable<T[keyof T]>>();
  return {
    current: () => current,
    field<K extends keyof T>(key: K): Atom.Atom<T[K]> {
      let field = fields.get(key);
      if (!field) {
        field = Atom.writable<T[keyof T], T[keyof T]>(
          () => current[key],
          (ctx, value) => ctx.setSelf(value),
        );
        fields.set(key, field);
      }
      return field as unknown as Atom.Atom<T[K]>;
    },
    set(next: T) {
      const previous = current;
      current = shareValue(previous, next);
      if (current === previous) return;
      Atom.batch(() => {
        for (const [key, field] of fields) {
          if (!Object.is(previous[key], current[key])) registry.set(field, current[key]);
        }
      });
    },
  };
}

export type UiLoad<A> = A | Promise<A> | Effect.Effect<A, unknown>;

export function loadEffect<A>(load: () => UiLoad<A>): Effect.Effect<A, unknown> {
  return Effect.suspend(() => {
    const result = load();
    return Effect.isEffect(result)
      ? result
      : result instanceof Promise
        ? Effect.tryPromise({ try: () => result, catch: (cause) => cause })
        : Effect.succeed(result);
  });
}

interface ResourceEntry {
  atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;
  load: () => UiLoad<unknown>;
}

export function makeUiModel() {
  const registry = AtomRegistry.make({ defaultIdleTTL: 30_000 });
  const generation = Atom.keepAlive(Atom.make(0));
  const resources = new Map<string, ResourceEntry>();
  return {
    registry,
    generation,
    resource<A>(
      key: string,
      load: () => UiLoad<A>,
    ): Atom.Atom<AsyncResult.AsyncResult<A, unknown>> {
      let entry = resources.get(key);
      if (entry) entry.load = load;
      else {
        const next: ResourceEntry = {
          load,
          atom: Atom.make((get) => {
            const previous = Option.flatMap(
              get.self<AsyncResult.AsyncResult<unknown, unknown>>(),
              AsyncResult.value,
            );
            return loadEffect(() => next.load()).pipe(
              Effect.map((value) =>
                Option.isSome(previous) ? shareValue(previous.value, value) : value,
              ),
            );
          }),
        };
        entry = next;
        resources.set(key, entry);
      }
      // Bound definitions as well as the registry's values. Mounted resources stay shared.
      if (resources.size > 512) {
        for (const [oldKey, old] of resources) {
          if (resources.size <= 512) break;
          if (oldKey !== key && !registry.getNodes().has(old.atom)) resources.delete(oldKey);
        }
      }
      return entry.atom as Atom.Atom<AsyncResult.AsyncResult<A, unknown>>;
    },
    invalidate(prefix: string) {
      for (const [key, entry] of resources)
        if (key.startsWith(prefix)) registry.refresh(entry.atom);
    },
    resetResources() {
      Atom.batch(() => {
        for (const entry of resources.values()) {
          entry.load = () => Effect.interrupt;
          registry.refresh(entry.atom);
        }
        resources.clear();
        registry.update(generation, (value) => value + 1);
      });
    },
    dispose() {
      registry.dispose();
      resources.clear();
    },
  };
}

export type UiModel = ReturnType<typeof makeUiModel>;

export interface UiPage<A, Cursor> {
  items: A[];
  totalCount?: number;
  next: Cursor | undefined;
}

/** Cursor progress and prior successful pages belong to the resource, including retries. */
export function makePagedResource<A, Cursor>(
  registry: AtomRegistry.AtomRegistry,
  load: (cursor: Cursor | undefined) => UiLoad<UiPage<A, Cursor>>,
  itemKey: (item: A) => string,
) {
  type Page = UiPage<A, Cursor> & { pageCount: number };
  const requested = Atom.make(1);
  const atom = Atom.make((get) => {
    const count = get(requested);
    const previous = Option.getOrUndefined(
      Option.flatMap(get.self<AsyncResult.AsyncResult<Page, unknown>>(), AsyncResult.value),
    );
    const append = previous && count === previous.pageCount + 1 ? previous : undefined;
    return loadEffect(() => load(append?.next)).pipe(
      Effect.map((page): Page => {
        const known = new Set(append?.items.map(itemKey));
        const incoming = page.items.filter((item) => {
          const key = itemKey(item);
          if (known.has(key)) return false;
          known.add(key);
          return true;
        });
        return {
          ...page,
          items: append ? [...append.items, ...incoming] : incoming,
          pageCount: append ? count : 1,
        };
      }),
    );
  }).pipe(Atom.setIdleTTL(0));
  return {
    atom,
    more() {
      const result = registry.get(atom);
      const previous = Option.getOrUndefined(AsyncResult.value(result));
      if (result.waiting || !previous || previous.next === undefined) return;
      Atom.batch(() => {
        registry.set(requested, previous.pageCount + 1);
        registry.refresh(atom);
      });
    },
    refresh() {
      Atom.batch(() => {
        registry.set(requested, 1);
        registry.refresh(atom);
      });
    },
  };
}
