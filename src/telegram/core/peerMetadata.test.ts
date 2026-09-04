import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { makePeerMetadata } from './peerMetadata';
import { makeResourceCache } from './resourceCache';

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe('peer metadata', () => {
  it('coalesces persisted and remote reads per peer', () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const cacheRelease = yield* Deferred.make<void>();
          const load = vi.fn(() => Deferred.await(cacheRelease).pipe(Effect.as(undefined)));
          const requests = yield* makeResourceCache();
          const metadata = makePeerMetadata<string, Error>('test', requests, {
            load,
            save: () => Effect.void,
            remove: () => Effect.void,
            onFailure: () => Effect.void,
          });
          const firstCache = yield* metadata.cached('u:1').pipe(Effect.forkChild);
          const secondCache = yield* metadata.cached('u:1').pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(cacheRelease, undefined);
          yield* Effect.all([Fiber.join(firstCache), Fiber.join(secondCache)]);

          const remoteRelease = yield* Deferred.make<string>();
          const remote = vi.fn(() => Deferred.await(remoteRelease));
          const firstRemote = yield* metadata.request('u:1', remote).pipe(Effect.forkChild);
          const secondRemote = yield* metadata.request('u:1', remote).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(remoteRelease, 'members');
          expect(yield* Effect.all([Fiber.join(firstRemote), Fiber.join(secondRemote)])).toEqual([
            'members',
            'members',
          ]);
          expect(load).toHaveBeenCalledOnce();
          expect(remote).toHaveBeenCalledOnce();
        }),
      ),
    ));

  it('does not restore a persisted value invalidated while its read is pending', () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const release = yield* Deferred.make<{ value: string; savedAt: number }>();
          const requests = yield* makeResourceCache();
          const metadata = makePeerMetadata<string, Error>('test', requests, {
            load: () => Deferred.await(release),
            save: () => Effect.void,
            remove: () => Effect.void,
            onFailure: () => Effect.void,
          });
          const loading = yield* metadata.cached('u:1').pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* metadata.forget('u:1');
          yield* Deferred.succeed(release, { value: 'stale', savedAt: 1 });
          yield* Fiber.await(loading);
          expect(metadata.current('u:1')).toBeUndefined();
        }),
      ),
    ));

  it('keeps the in-memory value available when persistence fails', () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const failure = new Error('quota');
          const failures: Array<['save' | 'load' | 'remove', Error]> = [];
          const requests = yield* makeResourceCache();
          const metadata = makePeerMetadata<string, Error>('test', requests, {
            load: () => Effect.succeed(undefined),
            save: () => Effect.fail(failure),
            remove: () => Effect.void,
            onFailure: (operation, error) =>
              Effect.sync(() => {
                failures.push([operation, error]);
              }),
            now: () => 42,
          });
          yield* metadata.remember('u:1', 'fresh');
          expect(metadata.current('u:1')).toEqual({ value: 'fresh', savedAt: 42 });
          expect(failures).toEqual([['save', failure]]);
        }),
      ),
    ));
});
