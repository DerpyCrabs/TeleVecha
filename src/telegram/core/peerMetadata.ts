import { Effect } from 'effect';

import type { TimedCacheValue } from '../persistence/store';
import type { ResourceCache } from './resourceCache';

interface PeerMetadataOptions<Value, Error> {
  readonly load: (peerId: string) => Effect.Effect<TimedCacheValue<Value> | undefined, Error>;
  readonly save: (peerId: string, value: Value) => Effect.Effect<void, Error>;
  readonly remove: (peerId: string) => Effect.Effect<void, Error>;
  readonly onFailure: (operation: 'load' | 'save' | 'remove', error: Error) => Effect.Effect<void>;
  readonly now?: () => number;
}

interface PeerMetadataEntry<Value> {
  version: number;
  loaded: boolean;
  value?: TimedCacheValue<Value> | undefined;
}

/** Owns one persisted stale-while-revalidate value per peer. */
export function makePeerMetadata<Value, Error>(
  namespace: string,
  requests: ResourceCache,
  options: PeerMetadataOptions<Value, Error>,
) {
  const entries = new Map<string, PeerMetadataEntry<Value>>();
  let cacheScope = {};
  const now = options.now ?? Date.now;
  const cacheKey = (peerId: string) => `peer-metadata:${namespace}:cache:${peerId}`;
  const refreshKey = (peerId: string, version: number) =>
    `peer-metadata:${namespace}:refresh:${peerId}:${version}`;
  const entry = (peerId: string) => {
    const existing = entries.get(peerId);
    if (existing) return existing;
    const created: PeerMetadataEntry<Value> = { version: 0, loaded: false };
    entries.set(peerId, created);
    return created;
  };

  const cached = (peerId: string) =>
    Effect.gen(function* () {
      const current = entry(peerId);
      if (current.loaded) return current.value;
      const capturedScope = cacheScope;
      const capturedVersion = current.version;
      return yield* requests.load(cacheKey(peerId), () =>
        options.load(peerId).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              if (cacheScope === capturedScope && current.version === capturedVersion) {
                current.loaded = true;
                current.value = value;
              }
            }),
          ),
          Effect.tapError((error) => options.onFailure('load', error)),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      );
    });

  const request = (
    peerId: string,
    load: (version: number) => Effect.Effect<Value, Error>,
  ): Effect.Effect<Value, Error> =>
    Effect.gen(function* () {
      const current = entry(peerId);
      const version = current.version;
      return yield* requests.load(refreshKey(peerId, version), () => load(version));
    });

  const remember = (peerId: string, value: Value) => {
    const current = entry(peerId);
    current.loaded = true;
    current.value = { value, savedAt: now() };
    return options
      .save(peerId, value)
      .pipe(Effect.catch((error) => options.onFailure('save', error)));
  };

  const bump = Effect.fn(`PeerMetadata.${namespace}.bump`)(function* (peerId: string) {
    const current = entry(peerId);
    const previousVersion = current.version;
    current.version += 1;
    yield* requests.invalidate(
      `peer-metadata:${namespace}:version:${peerId}`,
      cacheKey(peerId),
      refreshKey(peerId, previousVersion),
    );
    return current.version;
  });

  const forget = Effect.fn(`PeerMetadata.${namespace}.forget`)(function* (peerId: string) {
    const current = entry(peerId);
    const previousVersion = current.version;
    current.version += 1;
    current.loaded = true;
    current.value = undefined;
    yield* requests.invalidate(
      `peer-metadata:${namespace}:version:${peerId}`,
      cacheKey(peerId),
      refreshKey(peerId, previousVersion),
    );
    return current.version;
  });

  const invalidate = Effect.fn(`PeerMetadata.${namespace}.invalidate`)(function* (peerId: string) {
    const version = yield* forget(peerId);
    yield* options.remove(peerId).pipe(Effect.catch((error) => options.onFailure('remove', error)));
    return version;
  });

  return {
    version: (peerId: string) => entry(peerId).version,
    current: (peerId: string) => entry(peerId).value,
    cached,
    request,
    remember,
    bump,
    forget,
    invalidate,
    isFresh: (peerId: string, ttlMs: number) => {
      const value = entry(peerId).value;
      return Boolean(value && now() - value.savedAt < ttlMs);
    },
    clear: Effect.gen(function* () {
      cacheScope = {};
      entries.clear();
      yield* requests.invalidatePrefix(`peer-metadata:${namespace}:`);
    }),
  };
}

export type PeerMetadata<Value> = ReturnType<typeof makePeerMetadata<Value, unknown>>;
