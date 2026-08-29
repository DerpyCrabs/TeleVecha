import { describe, expect, it, vi } from 'vitest';

import { bigIntToBytes, bytesToBigInt, concatBytes, readInt32Le, writeInt32Le } from '../bytes';
import type { AuthKey } from '../auth';
import type { PacketConnection } from '../connection';
import {
  aesIgeDecrypt,
  aesIgeEncrypt,
  createBrowserCryptoAdapter,
  type CryptoAdapter,
} from '../crypto';
import { createMtprotoSender } from './sender';
import type { TlCodec, TlObject } from './types';

function authKey(): AuthKey {
  return {
    bytes: Uint8Array.from({ length: 256 }, (_, index) => index),
    hash: new Uint8Array(20),
    auxHash: 0n,
    id: 123n,
    calculateNewNonceHash: async () => 0n,
  };
}

function connectionDouble(send: (payload: Uint8Array) => void = () => undefined) {
  const packetListeners = new Set<(packet: Uint8Array) => void>();
  const stateListeners = new Set<(connected: boolean) => void>();
  let connected = false;
  const connection: PacketConnection & { emitPacket(packet: Uint8Array): void } = {
    async connect() {
      connected = true;
      for (const listener of Array.from(stateListeners)) listener(true);
    },
    disconnect() {
      if (!connected) return;
      connected = false;
      for (const listener of Array.from(stateListeners)) listener(false);
    },
    isConnected: () => connected,
    send,
    subscribePackets(listener) {
      packetListeners.add(listener);
      return () => packetListeners.delete(listener);
    },
    subscribeState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    emitPacket(packet) {
      for (const listener of Array.from(packetListeners)) listener(packet);
    },
  };
  return connection;
}

async function incomingPacket(options: {
  key: AuthKey;
  crypto: Pick<CryptoAdapter, 'sha256'>;
  salt: bigint;
  sessionId: bigint;
  messageId: bigint;
  sequenceNumber?: number;
}) {
  const body = Uint8Array.of(1, 0, 0, 0);
  const inner = concatBytes(
    bigIntToBytes(options.salt, 8, { littleEndian: true, signed: true }),
    bigIntToBytes(options.sessionId, 8, { littleEndian: true, signed: true }),
    bigIntToBytes(options.messageId, 8, { littleEndian: true }),
    writeInt32Le(options.sequenceNumber ?? 1),
    writeInt32Le(body.length),
    body,
  );
  const padding = 12 + ((16 - ((inner.length + 12) % 16)) % 16);
  const plaintext = concatBytes(inner, new Uint8Array(padding));
  const large = await options.crypto.sha256(
    concatBytes(options.key.bytes.slice(96, 128), plaintext),
  );
  const messageKey = large.slice(8, 24);
  const [first, second] = await Promise.all([
    options.crypto.sha256(concatBytes(messageKey, options.key.bytes.slice(8, 44))),
    options.crypto.sha256(concatBytes(options.key.bytes.slice(48, 84), messageKey)),
  ]);
  const key = concatBytes(first.slice(0, 8), second.slice(8, 24), first.slice(24, 32));
  const iv = concatBytes(second.slice(0, 8), first.slice(8, 24), second.slice(24, 32));
  return concatBytes(
    bigIntToBytes(options.key.id, 8, { littleEndian: true }),
    messageKey,
    aesIgeEncrypt(key, iv, plaintext, { padding: 'none' }),
  );
}

async function outgoingHeader(
  packet: Uint8Array,
  key: AuthKey,
  crypto: Pick<CryptoAdapter, 'sha256'>,
) {
  const messageKey = packet.slice(8, 24);
  const [first, second] = await Promise.all([
    crypto.sha256(concatBytes(messageKey, key.bytes.slice(0, 36))),
    crypto.sha256(concatBytes(key.bytes.slice(40, 76), messageKey)),
  ]);
  const aesKey = concatBytes(first.slice(0, 8), second.slice(8, 24), first.slice(24, 32));
  const iv = concatBytes(second.slice(0, 8), first.slice(8, 24), second.slice(24, 32));
  const plaintext = aesIgeDecrypt(aesKey, iv, packet.slice(24));
  return {
    messageId: bytesToBigInt(plaintext.slice(16, 24), { littleEndian: true }),
    sequenceNumber: readInt32Le(plaintext, 24),
  };
}

function codecDouble(encode: (value: TlObject) => Uint8Array): TlCodec {
  return {
    encode,
    decode: () => ({ _: 'unused' }),
    resultTypeFor: () => undefined,
  };
}

function senderOptions(connection: () => PacketConnection, codec: TlCodec) {
  return {
    dcId: 2,
    connection,
    codec,
    crypto: createBrowserCryptoAdapter(),
    authKey: authKey(),
    authorize: async () => {
      throw new Error('A stored auth key must skip authorization.');
    },
    onAuthKey: () => undefined,
    reconnect: { retries: 0, delayMs: 0 },
  };
}

describe('MTProto sender failure recovery', () => {
  it('applies the configured retry budget to the initial connection', async () => {
    let attempts = 0;
    const sender = createMtprotoSender({
      ...senderOptions(
        () => {
          attempts += 1;
          const connection = connectionDouble();
          if (attempts === 1) {
            connection.connect = async () => {
              throw new Error('opening failed');
            };
          }
          return connection;
        },
        codecDouble(() => Uint8Array.of(1, 0, 0, 0)),
      ),
      reconnect: { retries: 1, delayMs: 0 },
    });

    await expect(sender.connect()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    sender.disconnect();
  });

  it('lets the opening retry owner handle a socket lost during authorization', async () => {
    const connections: PacketConnection[] = [];
    const sender = createMtprotoSender({
      ...senderOptions(
        () => {
          const connection = connectionDouble();
          connections.push(connection);
          return connection;
        },
        codecDouble(() => Uint8Array.of(1, 0, 0, 0)),
      ),
      authKey: undefined,
      async authorize() {
        connections[0]!.disconnect();
        return { authKey: authKey(), serverSalt: 1n, timeOffset: 0 };
      },
      reconnect: { retries: 1, delayMs: 0 },
    });

    await expect(sender.connect()).resolves.toBeUndefined();
    expect(connections).toHaveLength(2);
    expect(connections[1]?.isConnected()).toBe(true);
    sender.disconnect();
  });

  it('rejects a request when its second encode fails instead of stranding it', async () => {
    let targetEncodes = 0;
    const sender = createMtprotoSender(
      senderOptions(
        () => connectionDouble(),
        codecDouble((value) => {
          if (value._ === 'test.prepareFailure' && ++targetEncodes === 2) {
            throw new Error('encode failed');
          }
          return Uint8Array.of(1, 0, 0, 0);
        }),
      ),
    );
    await sender.connect();

    await expect(sender.invoke({ _: 'test.prepareFailure' })).rejects.toThrow('encode failed');
    sender.disconnect();
  });

  it('does not start duplicate reconnect loops when disconnect publishes synchronously', async () => {
    const connections: PacketConnection[] = [];
    const sender = createMtprotoSender(
      senderOptions(
        () => {
          const connection = connectionDouble(
            connections.length === 0
              ? () => {
                  throw new Error('socket write failed');
                }
              : undefined,
          );
          connections.push(connection);
          return connection;
        },
        codecDouble(() => Uint8Array.of(1, 0, 0, 0)),
      ),
    );

    await sender.connect();
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    await Promise.resolve();
    expect(connections).toHaveLength(2);
    expect(connections[1]?.isConnected()).toBe(true);
    sender.disconnect();
  });

  it('scopes invoke-after dependencies to one outgoing batch', async () => {
    const encodedNames: string[] = [];
    const sender = createMtprotoSender(
      senderOptions(
        () => connectionDouble(),
        codecDouble((value) => {
          encodedNames.push(value._);
          return Uint8Array.of(1, 0, 0, 0);
        }),
      ),
    );
    await sender.connect();
    const first = sender.invoke({ _: 'messages.sendMessage' }).catch(() => undefined);
    const second = sender.invoke({ _: 'messages.sendMessage' }).catch(() => undefined);
    await vi.waitFor(() =>
      expect(encodedNames.filter((name) => name === 'invokeAfterMsg')).toHaveLength(1),
    );

    const third = sender.invoke({ _: 'messages.sendMessage' }).catch(() => undefined);
    await vi.waitFor(() =>
      expect(encodedNames.filter((name) => name === 'messages.sendMessage').length).toBeGreaterThan(
        4,
      ),
    );
    expect(encodedNames.filter((name) => name === 'invokeAfterMsg')).toHaveLength(1);
    sender.disconnect();
    await Promise.all([first, second, third]);
  });

  it('does not queue a request twice when reconnect overtakes packet encryption', async () => {
    const connections: PacketConnection[] = [];
    const browserCrypto = createBrowserCryptoAdapter();
    let blockNextHash = false;
    let releaseHash!: () => void;
    let reportBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      reportBlocked = resolve;
    });
    const hashGate = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    const crypto = {
      ...browserCrypto,
      async sha256(bytes: Uint8Array) {
        if (blockNextHash) {
          blockNextHash = false;
          reportBlocked();
          await hashGate;
        }
        return browserCrypto.sha256(bytes);
      },
    };
    let targetEncodes = 0;
    let packetsSent = 0;
    const sender = createMtprotoSender({
      ...senderOptions(
        () => {
          const connection = connectionDouble(() => {
            packetsSent += 1;
          });
          connections.push(connection);
          return connection;
        },
        codecDouble((value) => {
          if (value._ === 'test.delayedEncryption') targetEncodes += 1;
          return Uint8Array.of(1, 0, 0, 0);
        }),
      ),
      crypto,
      reconnect: { retries: 1, delayMs: 0 },
    });
    await sender.connect();
    await vi.waitFor(() => expect(packetsSent).toBeGreaterThanOrEqual(1));
    blockNextHash = true;
    const request = sender.invoke({ _: 'test.delayedEncryption' }).catch(() => undefined);
    await blocked;

    connections[0]!.disconnect();
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    releaseHash();
    await vi.waitFor(() => expect(targetEncodes).toBe(4));
    await Promise.resolve();
    expect(targetEncodes).toBe(4);

    sender.disconnect();
    await request;
  });

  it('reconnects instead of processing an authenticated packet with an unknown salt', async () => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const baseCrypto = createBrowserCryptoAdapter();
    const crypto: CryptoAdapter = {
      ...baseCrypto,
      randomBytes: (length) => new Uint8Array(length).fill(1),
    };
    const key = authKey();
    const now = 1_700_000_000_000;
    const sender = createMtprotoSender({
      ...senderOptions(
        () => {
          const connection = connectionDouble();
          connections.push(connection);
          return connection;
        },
        codecDouble(() => Uint8Array.of(1, 0, 0, 0)),
      ),
      authKey: key,
      crypto,
      serverSalt: 5n,
      now: () => now,
    });
    await sender.connect();
    const sessionId = bytesToBigInt(new Uint8Array(8).fill(1), {
      littleEndian: true,
      signed: true,
    });
    connections[0]!.emitPacket(
      await incomingPacket({
        key,
        crypto,
        salt: 99n,
        sessionId,
        messageId: (1_700_000_000n << 32n) | 1n,
      }),
    );

    await vi.waitFor(() => expect(connections).toHaveLength(2));
    sender.disconnect();
  });

  it.each([
    [
      'bad-message',
      (messageId: bigint, sequenceNumber: number): TlObject => ({
        _: 'bad_msg_notification',
        badMsgId: messageId,
        badMsgSeqno: sequenceNumber,
        errorCode: 32,
      }),
    ],
    [
      'bad-server-salt',
      (messageId: bigint, sequenceNumber: number): TlObject => ({
        _: 'bad_server_salt',
        badMsgId: messageId,
        badMsgSeqno: sequenceNumber,
        errorCode: 48,
        newServerSalt: 6n,
      }),
    ],
  ])('accepts correlated even-sequence %s notifications', async (_name, recordFor) => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const packets: Uint8Array[] = [];
    const baseCrypto = createBrowserCryptoAdapter();
    const crypto: CryptoAdapter = {
      ...baseCrypto,
      randomBytes: (length) => new Uint8Array(length).fill(1),
    };
    const key = authKey();
    let decoded: TlObject = { _: 'unused' };
    let targetEncodes = 0;
    const codec: TlCodec = {
      encode(value) {
        if (value._ === 'test.serviceCorrection') targetEncodes += 1;
        return Uint8Array.of(1, 0, 0, 0);
      },
      decode: () => decoded,
      resultTypeFor: () => undefined,
    };
    const sender = createMtprotoSender({
      ...senderOptions(() => {
        const connection = connectionDouble((packet) => packets.push(packet));
        connections.push(connection);
        return connection;
      }, codec),
      authKey: key,
      crypto,
      serverSalt: 5n,
      now: () => 1_700_000_000_000,
    });
    await sender.connect();
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(1));
    const request = sender.invoke({ _: 'test.serviceCorrection' }).catch(() => undefined);
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(2));
    const sent = await outgoingHeader(packets.at(-1)!, key, crypto);
    decoded = recordFor(sent.messageId, sent.sequenceNumber);
    connections[0]!.emitPacket(
      await incomingPacket({
        key,
        crypto,
        salt: 5n,
        sessionId: bytesToBigInt(new Uint8Array(8).fill(1), {
          littleEndian: true,
          signed: true,
        }),
        messageId: (1_700_000_000n << 32n) | 1n,
        sequenceNumber: 0,
      }),
    );

    await vi.waitFor(() => expect(targetEncodes).toBe(4));
    expect(connections).toHaveLength(1);
    sender.disconnect();
    await request;
  });
});
