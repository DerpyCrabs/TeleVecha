import { BrowserCrypto, BrowserSocket } from '@effect/platform-browser';
import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { createMtprotoClient } from './client';

const providePlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(BrowserCrypto.layer),
    Effect.provide(BrowserSocket.layerWebSocketConstructor),
  ) as Effect.Effect<A, E>;

describe('MTProto client construction', () => {
  it('loads and normalizes its session inside the scoped module', () =>
    Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const load = vi.fn(() =>
              Effect.succeed({ mainDcId: 2, keys: { 2: 'ab'.repeat(256).toUpperCase() } }),
            );
            const client = yield* createMtprotoClient({
              apiId: 1,
              apiHash: 'hash',
              session: { load: load(), save: () => Effect.void, clear: Effect.void },
            });
            expect(client.apiId).toBe(1);
            expect(client.apiHash).toBe('hash');
            expect(load).toHaveBeenCalledOnce();
            expect(Object.keys(client)).toEqual(
              expect.arrayContaining(['connect', 'invoke', 'events']),
            );
          }),
        ),
      ),
    ));

  it('reports invalid durable session data as MtprotoError', () =>
    Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const result = yield* createMtprotoClient({
              apiId: 1,
              apiHash: 'hash',
              session: {
                load: Effect.succeed({ mainDcId: 0, keys: {} }),
                save: () => Effect.void,
                clear: Effect.void,
              },
            }).pipe(Effect.result);
            expect(result).toMatchObject({
              _tag: 'Failure',
              failure: { _tag: 'MtprotoError', kind: 'session' },
            });
          }),
        ),
      ),
    ));

  it('clears authorization keys when switching between production and test networks', () =>
    Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const saved: unknown[] = [];
            yield* createMtprotoClient({
              apiId: 1,
              apiHash: 'hash',
              isTestServer: true,
              session: {
                load: Effect.succeed({ mainDcId: 2, keys: { 2: 'ab'.repeat(256) } }),
                save: (value) =>
                  Effect.sync(() => {
                    saved.push(value);
                  }),
                clear: Effect.void,
              },
            });
            expect(saved).toEqual([{ mainDcId: 2, keys: {}, isTest: true }]);
          }),
        ),
      ),
    ));
});
