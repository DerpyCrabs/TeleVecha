import { BrowserCrypto, BrowserSocket } from '@effect/platform-browser';
import { Effect } from 'effect';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createMtprotoClient, telegramRpcErrorMessage, type MtprotoClient } from './client';
import { createMtprotoError } from './errors';
import type { MtprotoError } from './errors';
import { Api, type Tl } from './tl';

const session = {
  load: Effect.succeed(undefined),
  save: () => Effect.void,
  clear: Effect.void,
};

describe('MTProto client seam', () => {
  it.each([
    { apiId: 0, apiHash: 'hash' },
    { apiId: 1, apiHash: '   ' },
    { apiId: 1, apiHash: 'hash', requestRetries: Number.NaN },
    { apiId: 1, apiHash: 'hash', requestRetries: 1.5 },
    { apiId: 1, apiHash: 'hash', connectionRetries: -1 },
    { apiId: 1, apiHash: 'hash', floodSleepLimitSeconds: Number.POSITIVE_INFINITY },
  ])('rejects invalid client configuration in the error channel', (configuration) =>
    Effect.runPromise(
      Effect.scoped(
        createMtprotoClient({
          ...configuration,
          session,
        }).pipe(
          Effect.provide(BrowserCrypto.layer),
          Effect.provide(BrowserSocket.layerWebSocketConstructor),
          Effect.result,
          Effect.map((result) => {
            expect(result).toMatchObject({
              _tag: 'Failure',
              failure: { _tag: 'MtprotoError', kind: 'configuration' },
            });
          }),
        ),
      ),
    ),
  );

  it('exposes stable RPC error symbols without an error class', () => {
    const error = createMtprotoError('rpc', 'password required', {
      code: 401,
      details: { errorMessage: 'SESSION_PASSWORD_NEEDED' },
    });
    expect(telegramRpcErrorMessage(error)).toBe('SESSION_PASSWORD_NEEDED');
    expect(telegramRpcErrorMessage(new Error('other'))).toBeUndefined();
  });

  it('maps generated requests to generated result Effects', () => {
    const request = Api.updates.GetState({});
    type Result = Tl.ResultOf<typeof request>;
    const invoke = (client: MtprotoClient) => client.invoke(request);
    type Invocation = ReturnType<typeof invoke>;
    expectTypeOf<Result>().toEqualTypeOf<Tl.updates.State>();
    expectTypeOf<Invocation>().toEqualTypeOf<Effect.Effect<Tl.updates.State, MtprotoError>>();
  });
});
