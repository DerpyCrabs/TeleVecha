import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { createMtprotoSession, parseStoredSession, type SessionPersistence } from './index';
import { createMtprotoError } from '../errors';

const encodedKey = 'ab'.repeat(256);
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const persistence = (save: SessionPersistence['save'] = () => Effect.void): SessionPersistence => ({
  load: Effect.succeed(undefined),
  save,
  clear: Effect.void,
});

describe('MTProto session persistence', () => {
  it('parses and preserves the stored session shape', () =>
    run(
      Effect.gen(function* () {
        expect(yield* parseStoredSession(undefined)).toBeUndefined();
        expect(
          yield* parseStoredSession({
            mainDcId: 2,
            keys: { 2: encodedKey.toUpperCase() },
            isTest: true,
          }),
        ).toEqual({ mainDcId: 2, keys: { 2: encodedKey }, isTest: true });
        for (const productionMarker of [{}, { isTest: undefined }, { isTest: false }]) {
          expect(
            yield* parseStoredSession({
              mainDcId: 2,
              keys: { 2: encodedKey },
              ...productionMarker,
            }),
          ).toEqual({ mainDcId: 2, keys: { 2: encodedKey } });
        }
        for (const invalid of [
          { mainDcId: 2, keys: { 2: 'not-a-key' } },
          { mainDcId: 2, keys: { 0: encodedKey } },
          { mainDcId: 0, keys: {} },
        ]) {
          expect((yield* parseStoredSession(invalid).pipe(Effect.result))._tag).toBe('Failure');
        }
      }),
    ));

  it('serializes concurrent durable updates', () =>
    run(
      Effect.gen(function* () {
        const calls: string[] = [];
        const firstGate = yield* Deferred.make<void>();
        let writes = 0;
        const session = yield* createMtprotoSession(
          undefined,
          persistence((value) =>
            Effect.gen(function* () {
              writes += 1;
              if (writes === 1) {
                calls.push('first:start');
                yield* Deferred.await(firstGate);
                calls.push('first:end');
              } else {
                calls.push(`dc:${value.mainDcId}`);
              }
            }),
          ),
        );
        const first = yield* session.setMainDc(3).pipe(Effect.forkChild);
        const second = yield* session.setMainDc(4).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(calls).toEqual(['first:start']);
        yield* Deferred.succeed(firstGate, undefined);
        yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
        expect(calls).toEqual(['first:start', 'first:end', 'dc:4']);
      }),
    ));

  it('keeps the session usable after a persistence failure', () =>
    run(
      Effect.gen(function* () {
        let calls = 0;
        const session = yield* createMtprotoSession(
          undefined,
          persistence(() => {
            calls += 1;
            return calls === 1 ? Effect.fail(createMtprotoError('session', 'quota')) : Effect.void;
          }),
        );
        expect((yield* session.setMainDc(3).pipe(Effect.result))._tag).toBe('Failure');
        yield* session.setMainDc(4);
        expect((yield* session.snapshot).mainDcId).toBe(4);
      }),
    ));

  it('copies auth keys and clears durable state on delete', () =>
    run(
      Effect.gen(function* () {
        const clear = vi.fn();
        const session = yield* createMtprotoSession(undefined, {
          load: Effect.succeed(undefined),
          save: () => Effect.void,
          clear: Effect.sync(clear),
        });
        const key = new Uint8Array(256).fill(7);
        yield* session.setAuthKey(2, key);
        key.fill(9);
        expect((yield* session.authKey(2))?.[0]).toBe(7);
        yield* session.delete;
        expect(yield* session.authKey(2)).toBeUndefined();
        expect(clear).toHaveBeenCalledOnce();
      }),
    ));

  it('keeps keys across DC migrations and clears them across network changes', () =>
    run(
      Effect.gen(function* () {
        const save = vi.fn();
        const session = yield* createMtprotoSession(
          { mainDcId: 2, keys: { 2: encodedKey, 4: 'cd'.repeat(256) } },
          persistence((value) =>
            Effect.sync(() => {
              save(value);
            }),
          ),
        );
        yield* session.setMainDc(4);
        expect((yield* session.snapshot).keys).toEqual({ 2: encodedKey, 4: 'cd'.repeat(256) });
        yield* session.setMainDc(3, true);
        expect(yield* session.snapshot).toEqual({ mainDcId: 3, keys: {}, isTest: true });
        expect(yield* session.authKey(2)).toBeUndefined();
        expect(yield* session.authKey(4)).toBeUndefined();
        expect(save).toHaveBeenLastCalledWith({ mainDcId: 3, keys: {}, isTest: true });
      }),
    ));
});
