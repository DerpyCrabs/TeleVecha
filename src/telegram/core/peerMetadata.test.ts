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

  it('backs off failed refreshes per peer and resets after a success or invalidation', () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          let now = 0;
          const requests = yield* makeResourceCache();
          const metadata = makePeerMetadata<string, Error>('test', requests, {
            load: () => Effect.succeed(undefined),
            save: () => Effect.void,
            remove: () => Effect.void,
            onFailure: () => Effect.void,
            now: () => now,
          });
          yield* metadata.remember('u:1', 'cached');
          for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
            metadata.deferRefresh('u:1');
            expect(metadata.canRefresh('u:1')).toBe(false);
            expect(metadata.canRefresh('u:2')).toBe(true);
            expect(metadata.current('u:1')?.value).toBe('cached');
            now += delay - 1;
            expect(metadata.canRefresh('u:1')).toBe(false);
            now += 1;
            expect(metadata.canRefresh('u:1')).toBe(true);
          }
          yield* metadata.remember('u:1', 'fresh');
          metadata.deferRefresh('u:1');
          now += 30_000;
          expect(metadata.canRefresh('u:1')).toBe(true);
          metadata.deferRefresh('u:1');
          yield* metadata.bump('u:1');
          expect(metadata.canRefresh('u:1')).toBe(true);
          metadata.deferRefresh('u:1');
          yield* metadata.clear;
          expect(metadata.canRefresh('u:1')).toBe(true);
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

it('does not let an older disk read replace freshly remembered metadata', () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<{ value: string; savedAt: number }>();
        const started = yield* Deferred.make<void>();
        const requests = yield* makeResourceCache();
        const metadata = makePeerMetadata<string, never>('pins', requests, {
          load: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          save: () => Effect.void,
          remove: () => Effect.void,
          onFailure: () => Effect.void,
        });
        const reading = yield* metadata.cached('p').pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* metadata.remember('p', 'new');
        yield* Deferred.succeed(release, { value: 'old', savedAt: 1 });
        expect((yield* Fiber.join(reading))?.value).toBe('new');
        expect(metadata.current('p')?.value).toBe('new');
      }),
    ),
  ));
