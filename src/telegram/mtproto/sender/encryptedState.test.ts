import { describe, expect, it } from 'vitest';
import { Crypto, Effect } from 'effect';

import { bigIntToBytes, bytesToBigInt, concatBytes, writeInt32Le } from '../bytes';
import type { AuthKey } from '../auth';
import { aesIgeEncrypt } from '../crypto';
import { createEncryptedMessageState } from './encryptedState';

function authKey(): AuthKey {
  return {
    bytes: Uint8Array.from({ length: 256 }, (_, index) => index),
    hash: new Uint8Array(20),
    auxHash: 0n,
    id: 0xfedc_ba98_7654_3210n,
    calculateNewNonceHash: () => Effect.succeed(0n),
  };
}

function cryptoDouble() {
  let randomByte = 1;
  return {
    randomBytes(length: number) {
      const output = new Uint8Array(length).fill(randomByte);
      randomByte += 1;
      return output;
    },
    async sha256(bytes: Uint8Array) {
      const output = new Uint8Array(32);
      for (let index = 0; index < bytes.length; index += 1) {
        const position = index % output.length;
        output[position] = output[position]! ^ bytes[index]!;
      }
      return output;
    },
  };
}

async function incomingPacket(options: {
  authKey: AuthKey;
  crypto: ReturnType<typeof cryptoDouble>;
  serverSalt: bigint;
  sessionId: bigint;
  messageId: bigint;
  sequenceNumber?: number;
  body?: Uint8Array;
}) {
  const body = options.body ?? Uint8Array.of(1, 2, 3, 4);
  const inner = concatBytes(
    bigIntToBytes(options.serverSalt, 8, { littleEndian: true, signed: true }),
    bigIntToBytes(options.sessionId, 8, { littleEndian: true, signed: true }),
    bigIntToBytes(options.messageId, 8, { littleEndian: true }),
    writeInt32Le(options.sequenceNumber ?? 1),
    writeInt32Le(body.length),
    body,
  );
  const paddingLength = 12 + ((16 - ((inner.length + 12) % 16)) % 16);
  const plaintext = concatBytes(inner, new Uint8Array(paddingLength));
  const messageKeyLarge = await options.crypto.sha256(
    concatBytes(options.authKey.bytes.slice(96, 128), plaintext),
  );
  const messageKey = messageKeyLarge.slice(8, 24);
  const [first, second] = await Promise.all([
    options.crypto.sha256(concatBytes(messageKey, options.authKey.bytes.slice(8, 44))),
    options.crypto.sha256(concatBytes(options.authKey.bytes.slice(48, 84), messageKey)),
  ]);
  const key = concatBytes(first.slice(0, 8), second.slice(8, 24), first.slice(24, 32));
  const iv = concatBytes(second.slice(0, 8), first.slice(8, 24), second.slice(24, 32));
  return concatBytes(
    bigIntToBytes(options.authKey.id, 8, { littleEndian: true }),
    messageKey,
    aesIgeEncrypt(key, iv, plaintext, { padding: 'none' }),
  );
}

describe('encrypted MTProto message state', () => {
  const makeState = (
    options: Parameters<typeof createEncryptedMessageState>[0],
    crypto = cryptoDouble(),
  ) =>
    Effect.runPromise(
      createEncryptedMessageState(options).pipe(
        Effect.provideService(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (length) => crypto.randomBytes(length),
            digest: (_algorithm, bytes) => Effect.promise(() => crypto.sha256(bytes)),
          }),
        ),
      ),
    );

  it('generates monotonic IDs and content-related sequence numbers', async () => {
    const state = await makeState({ authKey: authKey(), now: () => 1_700_000_000_000 });
    const { prepare } = state;
    const first = prepare(Uint8Array.of(1, 2, 3, 4), true);
    const second = prepare(Uint8Array.of(5, 6, 7, 8), false);
    const third = prepare(Uint8Array.of(9, 10, 11, 12), true);

    expect([first.sequenceNumber, second.sequenceNumber, third.sequenceNumber]).toEqual([1, 2, 3]);
    expect(first.messageId < second.messageId && second.messageId < third.messageId).toBe(true);
    expect(first.messageId & 3n).toBe(0n);
    expect(() => prepare(Uint8Array.of(1, 2, 3), true)).toThrow('four-byte aligned');
  });

  it('keeps methods destructurable and serializes unsigned auth-key IDs', async () => {
    const state = await makeState({
      authKey: authKey(),
      now: () => 1_700_000_000_123,
      serverSalt: -2n,
    });
    const { encrypt } = state;
    const result = await Effect.runPromise(encrypt(Uint8Array.of(1, 2, 3, 4), true));

    expect(bytesToBigInt(result.packet.slice(0, 8), { littleEndian: true })).toBe(
      0xfedc_ba98_7654_3210n,
    );
    expect(result.packet.length % 16).toBe(8);
  });

  it('reports unknown salts and retains only the replaced current salt for grace', async () => {
    let now = 1_700_000_000_000;
    const key = authKey();
    const crypto = cryptoDouble();
    const session = bytesToBigInt(new Uint8Array(8).fill(1), { littleEndian: true, signed: true });
    const state = await makeState({ authKey: key, now: () => now, serverSalt: 5n }, crypto);
    const firstMessageId = (1_700_000_000n << 32n) | 1n;
    const known = await Effect.runPromise(
      state.decrypt(
        await incomingPacket({
          authKey: key,
          crypto,
          serverSalt: 5n,
          sessionId: session,
          messageId: firstMessageId,
        }),
      ),
    );
    expect(known.saltInvalid).toBe(false);

    state.setFutureSalts([
      { salt: 6n, validSince: 1_699_999_990, validUntil: 1_700_000_010 },
      { salt: 7n, validSince: 1_700_000_020, validUntil: 1_700_000_030 },
    ]);
    expect(state.getServerSalt()).toBe(6n);
    now += 40_000;
    const oldCurrent = await Effect.runPromise(
      state.decrypt(
        await incomingPacket({
          authKey: key,
          crypto,
          serverSalt: 5n,
          sessionId: session,
          messageId: (1_700_000_040n << 32n) | 1n,
        }),
      ),
    );
    const expiredFuture = await Effect.runPromise(
      state.decrypt(
        await incomingPacket({
          authKey: key,
          crypto,
          serverSalt: 7n,
          sessionId: session,
          messageId: (1_700_000_040n << 32n) | 5n,
        }),
      ),
    );
    expect(oldCurrent.saltInvalid).toBe(false);
    expect(expiredFuture.saltInvalid).toBe(true);

    now += 1_801_000;
    const graceExpired = await Effect.runPromise(
      state.decrypt(
        await incomingPacket({
          authKey: key,
          crypto,
          serverSalt: 5n,
          sessionId: session,
          messageId: (1_700_001_841n << 32n) | 1n,
        }),
      ),
    );
    expect(graceExpired.saltInvalid).toBe(true);
  });

  it('rejects replayed packets below the retained message-id floor', async () => {
    const key = authKey();
    const crypto = cryptoDouble();
    const session = bytesToBigInt(new Uint8Array(8).fill(1), { littleEndian: true, signed: true });
    const state = await makeState(
      { authKey: key, now: () => 1_700_000_000_000, serverSalt: 5n },
      crypto,
    );
    const first = await incomingPacket({
      authKey: key,
      crypto,
      serverSalt: 5n,
      sessionId: session,
      messageId: (1_700_000_000n << 32n) | 1n,
    });
    await Effect.runPromise(state.decrypt(first));
    for (let index = 1; index <= 1_000; index += 1) {
      await Effect.runPromise(
        state.decrypt(
          await incomingPacket({
            authKey: key,
            crypto,
            serverSalt: 5n,
            sessionId: session,
            messageId: (1_700_000_000n << 32n) | (BigInt(index) * 4n + 1n),
          }),
        ),
      );
    }

    await expect(Effect.runPromise(state.decrypt(first))).rejects.toThrow('replayed');
  });
});
