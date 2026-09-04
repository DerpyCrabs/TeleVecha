import { Deferred, Effect, Fiber, Scope } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { makeResourceCache } from './resourceCache';

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

describe('ResourceCache', () => {
  it('coalesces concurrent loads and releases the request afterward', () =>
    run(
      Effect.gen(function* () {
        const cache = yield* makeResourceCache();
        const release = yield* Deferred.make<Blob>();
        const loader = vi.fn(() => Deferred.await(release));
        const firstLoad = yield* cache
          .load('media:1', loader)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const secondLoad = yield* cache
          .load('media:1', loader)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const value = new Blob(['media']);
        yield* Deferred.succeed(release, value);
        const [first, second] = yield* Effect.all([Fiber.join(firstLoad), Fiber.join(secondLoad)]);
        expect(first).toBe(second);
        expect(loader).toHaveBeenCalledOnce();
        yield* cache.load('media:1', loader);
        expect(loader).toHaveBeenCalledTimes(2);
      }),
    ));

  it('exposes pending work without exposing its request registry', () =>
    run(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const cache = yield* makeResourceCache();
        const loading = yield* cache
          .load('read-receipt:u:1', () => Deferred.await(release))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(cache.pending('read-receipt:u:1')).toBe(true);
        expect(cache.pendingWithPrefix('read-receipt:')).toHaveLength(1);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(loading);
        expect(cache.pending('read-receipt:u:1')).toBe(false);
      }),
    ));

  it('invalidates versions and selected in-flight keys together', () =>
    run(
      Effect.gen(function* () {
        const cache = yield* makeResourceCache();
        const loader = vi.fn(() => Effect.succeed({ theme: 'night' }));
        expect(yield* cache.cached('appearance:1', loader)).toEqual({ theme: 'night' });
        yield* cache.invalidate('message:1', 'media:old');
        expect(cache.version('message:1')).toBe(1);
        yield* cache.forget('appearance:1');
        yield* cache.cached('appearance:1', loader);
        expect(loader).toHaveBeenCalledTimes(2);
      }),
    ));

  it('caches an explicit undefined value', () =>
    run(
      Effect.gen(function* () {
        const cache = yield* makeResourceCache();
        const loader = vi.fn(() => Effect.succeed(undefined));
        expect(yield* cache.cached('appearance:missing', loader)).toBeUndefined();
        expect(yield* cache.cached('appearance:missing', loader)).toBeUndefined();
        expect(loader).toHaveBeenCalledOnce();
      }),
    ));

  it('does not retain failures', () =>
    run(
      Effect.gen(function* () {
        const cache = yield* makeResourceCache();
        const load = vi.fn(() => Effect.fail(new Error('download failed')));
        const cached = vi.fn(() => Effect.fail(new Error('metadata failed')));
        for (const operation of [
          cache.load('media:failed', load),
          cache.load('media:failed', load),
          cache.cached('metadata:failed', cached),
          cache.cached('metadata:failed', cached),
        ]) {
          expect((yield* Effect.result(operation))._tag).toBe('Failure');
        }
        expect(load).toHaveBeenCalledTimes(2);
        expect(cached).toHaveBeenCalledTimes(2);
      }),
    ));

  it('does not let forgotten or cleared work restore stale data', () =>
    run(
      Effect.gen(function* () {
        const cache = yield* makeResourceCache();
        const stale = yield* Deferred.make<string>();
        const first = yield* cache
          .cached('appearance:1', () => Deferred.await(stale))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* cache.forget('appearance:1');
        yield* Fiber.await(first);
        expect(yield* cache.cached('appearance:1', () => Effect.succeed('fresh'))).toBe('fresh');

        const oldAccount = yield* Deferred.make<string>();
        const old = yield* cache
          .cached('account-scoped', () => Deferred.await(oldAccount))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* cache.clear;
        yield* Fiber.await(old);
        expect(yield* cache.cached('account-scoped', () => Effect.succeed('new account'))).toBe(
          'new account',
        );
      }),
    ));

  it('keeps a replacement request when an old finalizer completes', () =>
    run(
      Effect.gen(function* () {
        const cache = yield* makeResourceCache();
        const oldValue = yield* Deferred.make<string>();
        const freshValue = yield* Deferred.make<string>();
        const oldLoad = yield* cache
          .load('media:1', () => Deferred.await(oldValue))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* cache.invalidate('message:1', 'media:1');
        const freshLoader = vi.fn(() => Deferred.await(freshValue));
        const freshLoad = yield* cache
          .load('media:1', freshLoader)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.await(oldLoad);
        const joinedFreshLoad = yield* cache
          .load('media:1', freshLoader)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(freshValue, 'fresh');
        expect(yield* Effect.all([Fiber.join(freshLoad), Fiber.join(joinedFreshLoad)])).toEqual([
          'fresh',
          'fresh',
        ]);
        expect(freshLoader).toHaveBeenCalledOnce();
      }),
    ));
});
