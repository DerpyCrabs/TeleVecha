import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CryptoAdapter } from './crypto';
import type { MtprotoSender, MtprotoSenderOptions, TlObject } from './sender';

interface SenderDouble extends MtprotoSender {
  readonly testState: {
    connectCalls: number;
    invocations: TlObject[];
  };
  forceOffline(): void;
}

const harness = vi.hoisted(() => ({ senders: [] as SenderDouble[] }));

vi.mock('./sender', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sender')>();
  return {
    ...actual,
    createMtprotoSender: vi.fn((_options: MtprotoSenderOptions) => {
      let connected = false;
      const testState = { connectCalls: 0, invocations: [] as TlObject[] };
      const sender: SenderDouble = {
        dcId: 2,
        testState,
        async connect() {
          testState.connectCalls += 1;
          connected = true;
        },
        disconnect() {
          connected = false;
        },
        forceOffline() {
          connected = false;
        },
        isConnected: () => connected,
        async invoke<Result>(request: TlObject) {
          testState.invocations.push(request);
          return { _: 'test.result' } as Result;
        },
        subscribe: () => () => undefined,
      };
      harness.senders.push(sender);
      return sender;
    }),
  };
});

import { createMtprotoClient } from './client';
import { Api } from './tl';

function cryptoDouble(): CryptoAdapter {
  return {
    randomBytes: (length) => new Uint8Array(length),
    sha1: async () => new Uint8Array(20),
    sha256: async () => new Uint8Array(32),
    pbkdf2Sha512: async (_password, _salt, _iterations, bits) => new Uint8Array(bits / 8),
  };
}

describe('MTProto client lifecycle recovery', () => {
  beforeEach(() => {
    harness.senders.length = 0;
  });

  it('reopens an offline sender without superseding the active client lifecycle', async () => {
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      session: {
        load: async () => ({ mainDcId: 2, keys: { 2: '00'.repeat(256) } }),
        save: async () => undefined,
        clear: async () => undefined,
      },
      crypto: cryptoDouble(),
    });
    await client.connect();
    const sender = harness.senders[0]!;
    sender.forceOffline();

    await expect(client.invoke(Api.updates.GetState({}))).resolves.toEqual({ _: 'test.result' });
    expect(sender.testState.connectCalls).toBe(2);
    expect(client.isConnected()).toBe(true);
    expect(sender.testState.invocations.at(-1)?._).toBe('updates.getState');
    client.disconnect();
  });
});
