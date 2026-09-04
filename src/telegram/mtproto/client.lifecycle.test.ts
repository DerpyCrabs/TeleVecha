import { BrowserCrypto, BrowserSocket } from '@effect/platform-browser';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { MtprotoClientService, mtprotoClientLayer } from './client';

const session = {
  load: Effect.succeed(undefined),
  save: () => Effect.void,
  clear: Effect.void,
};

describe('MTProto client layer lifecycle', () => {
  it('memoizes one client service for the enclosing scope', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* MtprotoClientService;
          const second = yield* MtprotoClientService;
          expect(first).toBe(second);
        }).pipe(
          Effect.provide(mtprotoClientLayer({ apiId: 1, apiHash: 'hash', session })),
          Effect.provide(BrowserCrypto.layer),
          Effect.provide(BrowserSocket.layerWebSocketConstructor),
        ),
      ),
    ));

  it('fails layer construction for invalid configuration', () =>
    Effect.runPromise(
      Effect.scoped(
        MtprotoClientService.pipe(
          Effect.provide(mtprotoClientLayer({ apiId: 0, apiHash: 'hash', session })),
          Effect.result,
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toMatchObject({
                _tag: 'Failure',
                failure: { _tag: 'MtprotoError', kind: 'configuration' },
              });
            }),
          ),
          Effect.provide(BrowserCrypto.layer),
          Effect.provide(BrowserSocket.layerWebSocketConstructor),
        ),
      ),
    ));
});
