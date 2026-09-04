import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  getListener,
  onCleanup,
  useContext,
  untrack,
  type Accessor,
  type JSX,
} from 'solid-js';
import { Cause, Option } from 'effect';
import * as Atom from 'effect/unstable/reactivity/Atom';
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult';
import {
  loadEffect,
  makePagedResource,
  makeRecord,
  makeUiModel,
  type UiLoad,
  type UiModel,
  type UiPage,
} from './model';

const ModelContext = createContext<UiModel>();

export function UiModelProvider(props: { children: JSX.Element }) {
  const model = makeUiModel();
  onCleanup(() => model.dispose());
  return <ModelContext.Provider value={model}>{props.children}</ModelContext.Provider>;
}

export function useUiModel() {
  const shared = useContext(ModelContext);
  if (shared) return shared;
  const model = makeUiModel();
  onCleanup(() => model.dispose());
  return model;
}

/** The only subscription-to-Solid conversion for application data. */
function observe<A>(model: UiModel, atom: Atom.Atom<A>) {
  return untrack(() => {
    const [value, setValue] = createSignal(model.registry.get(atom));
    const dispose = model.registry.subscribe(atom, (next) => setValue(() => next), {
      immediate: true,
    });
    return { value, dispose };
  });
}

export function createRecordView<T extends object>(initial: T, model: UiModel) {
  const record = makeRecord(model.registry, initial);
  let disposed = false;
  const observations = new Map<keyof T, ReturnType<typeof observe<T[keyof T]>>>();
  const value = new Proxy({} as T, {
    get(_target, key: string) {
      if (disposed) return record.current()[key as keyof T];
      const field = record.field(key as keyof T);
      if (!getListener()) return model.registry.get(field);
      let observation = observations.get(key as keyof T);
      if (!observation) {
        observation = observe(model, field);
        observations.set(key as keyof T, observation);
      }
      return observation.value();
    },
    ownKeys: () => Reflect.ownKeys(record.current()),
    has: (_target, key) => key in record.current(),
    getOwnPropertyDescriptor: (_target, key) =>
      Object.hasOwn(record.current(), key) ? { enumerable: true, configurable: true } : undefined,
  });
  return {
    value,
    set: (next: T) => {
      if (!disposed) batch(() => record.set(next));
    },
    dispose: () => {
      disposed = true;
      for (const observation of observations.values()) observation.dispose();
      observations.clear();
    },
  };
}

export function createEntityViews<T extends object>(capacity = Number.POSITIVE_INFINITY) {
  const model = useUiModel();
  const entries = new Map<string, ReturnType<typeof createRecordView<T>>>();
  onCleanup(() => {
    for (const entry of entries.values()) entry.dispose();
  });
  return {
    get(key: string, next: T) {
      let entry = entries.get(key);
      if (entry) {
        entry.set(next);
        entries.delete(key);
      } else entry = createRecordView(next, model);
      entries.set(key, entry);
      return entry.value;
    },
    retain(visibleKeys: ReadonlySet<string>) {
      for (const [key, entry] of entries) {
        if (entries.size <= capacity) break;
        if (!visibleKeys.has(key)) {
          entry.dispose();
          entries.delete(key);
        }
      }
    },
  };
}

/** Sync and async producers expose the same read/loading/error interface. Values never cross keys. */
export function createUiResource<K, A>(
  source: Accessor<K | false | null | undefined>,
  load: (key: K) => UiLoad<A>,
  options: { namespace?: string; key?: (key: K) => string } = {},
) {
  const model = useUiModel();
  const generation = observe(model, model.generation);
  onCleanup(generation.dispose);
  const selected = createMemo(() => {
    generation.value();
    const key = source();
    if (key === false || key === null || key === undefined) return undefined;
    // Unnamed resources own only their current read. MediaAssets, for example,
    // already owns blob/URL caching, so retaining another URL cache here is wrong.
    if (!options.namespace) return Atom.make(loadEffect(() => load(key))).pipe(Atom.setIdleTTL(0));
    return model.resource(
      `${options.namespace}:${options.key ? options.key(key) : String(key)}`,
      () => load(key),
    );
  });
  const result = createMemo(() => {
    const atom = selected();
    if (!atom) return () => AsyncResult.initial<A, unknown>();
    const observation = observe(model, atom);
    onCleanup(observation.dispose);
    return observation.value;
  });
  const state = () => result()();
  const value = () => Option.getOrUndefined(AsyncResult.value(state()));
  const read = Object.defineProperties(value, {
    loading: { get: () => state().waiting },
    error: {
      get: () => {
        const result = state();
        return AsyncResult.isFailure(result) ? Cause.squash(result.cause) : undefined;
      },
    },
  }) as Accessor<A | undefined> & { readonly loading: boolean; readonly error: unknown };
  return [
    read,
    {
      state,
      refetch: () => {
        const atom = selected();
        if (atom) model.registry.refresh(atom);
      },
    },
  ] as const;
}

export function createDebouncedValue<T>(source: Accessor<T>, delay = 250) {
  const [value, setValue] = createSignal(source());
  createEffect(() => {
    const next = source();
    const timer = setTimeout(() => setValue(() => next), delay);
    onCleanup(() => clearTimeout(timer));
  });
  return value;
}

export function createUiPages<K, A, Cursor>(
  source: Accessor<K | false | undefined>,
  load: (key: K, cursor: Cursor | undefined) => UiLoad<UiPage<A, Cursor>>,
  options: { key: (key: K) => string; itemKey: (item: A) => string },
) {
  const model = useUiModel();
  const generation = observe(model, model.generation);
  onCleanup(generation.dispose);
  const selected = createMemo(
    () => {
      const key = source();
      return key === false || key === undefined
        ? undefined
        : { key: `${generation.value()}:${options.key(key)}`, request: key };
    },
    undefined,
    { equals: (a, b) => a?.key === b?.key },
  );
  const resource = createMemo(() => {
    const selectedKey = selected();
    if (!selectedKey) return undefined;
    const page = makePagedResource(
      model.registry,
      (cursor: Cursor | undefined) => load(selectedKey.request, cursor),
      options.itemKey,
    );
    const observation = observe(model, page.atom);
    onCleanup(observation.dispose);
    return { ...page, state: observation.value };
  });
  const state = () => resource()?.state() ?? AsyncResult.initial<UiPage<A, Cursor>, unknown>();
  const value = () => Option.getOrUndefined(AsyncResult.value(state()));
  return {
    items: () => value()?.items ?? [],
    totalCount: () => value()?.totalCount,
    loading: () => state().waiting && value() === undefined,
    loadingMore: () => state().waiting && value() !== undefined,
    hasMore: () => value()?.next !== undefined,
    error: () => {
      const result = state();
      return AsyncResult.isFailure(result) ? String(Cause.squash(result.cause)) : '';
    },
    more: () => resource()?.more(),
    refresh: () => resource()?.refresh(),
  };
}
