import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { Api, type Tl } from './tl';
import { createMtprotoClient, telegramRpcErrorMessage } from './client';
import type { CryptoAdapter } from './crypto';
import { createMtprotoError } from './errors';

function cryptoDouble(): CryptoAdapter {
  return {
    randomBytes: (length) => new Uint8Array(length),
    sha1: async () => new Uint8Array(20),
    sha256: async () => new Uint8Array(32),
    pbkdf2Sha512: async (_password, _salt, _iterations, bits) => new Uint8Array(bits / 8),
  };
}

describe('MTProto client seam', () => {
  it('invalidates a connection attempt that finishes loading after disconnect', async () => {
    let finishLoad!: (value: unknown) => void;
    const load = new Promise<unknown>((resolve) => {
      finishLoad = resolve;
    });
    const connectionFactory = vi.fn();
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      session: {
        load: () => load,
        save: async () => undefined,
        clear: async () => undefined,
      },
      crypto: cryptoDouble(),
      connectionFactory,
    });

    const connecting = client.connect();
    client.disconnect();
    finishLoad(undefined);

    await expect(connecting).rejects.toThrow('superseded');
    expect(connectionFactory).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });

  it('exposes stable RPC error symbols without requiring an error class', () => {
    const error = createMtprotoError('rpc', 'password required', {
      code: 401,
      details: { errorMessage: 'SESSION_PASSWORD_NEEDED' },
    });
    expect(telegramRpcErrorMessage(error)).toBe('SESSION_PASSWORD_NEEDED');
    expect(telegramRpcErrorMessage(new Error('other'))).toBeUndefined();
  });

  it('maps generated requests to their generated result types', () => {
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      session: {
        load: async () => undefined,
        save: async () => undefined,
        clear: async () => undefined,
      },
      crypto: cryptoDouble(),
    });
    const request = Api.updates.GetState({});
    type Result = Tl.ResultOf<typeof request>;
    const result = () => client.invoke(request);
    expectTypeOf<Result>().toEqualTypeOf<Tl.updates.State>();
    expectTypeOf<ReturnType<typeof result>>().toEqualTypeOf<Promise<Tl.updates.State>>();
  });
});
