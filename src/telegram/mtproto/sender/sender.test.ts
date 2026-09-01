import { describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'fflate';

import {
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  readInt32Le,
  readUint32Le,
  writeInt32Le,
  writeUint32Le,
} from '../bytes';
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

function gzipPacked(body: Uint8Array) {
  const compressed = gzipSync(body);
  const prefix =
    compressed.length < 254
      ? Uint8Array.of(compressed.length)
      : Uint8Array.of(
          254,
          compressed.length & 0xff,
          (compressed.length >>> 8) & 0xff,
          (compressed.length >>> 16) & 0xff,
        );
  const padding = (4 - ((prefix.length + compressed.length) % 4)) % 4;
  return concatBytes(writeUint32Le(0x3072cfa1), prefix, compressed, new Uint8Array(padding));
}

function messageCopy(messageId: bigint, sequenceNumber: number, body: Uint8Array) {
  return concatBytes(
    writeUint32Le(0xe06046b2),
    bigIntToBytes(messageId, 8, { littleEndian: true }),
    writeInt32Le(sequenceNumber),
    writeInt32Le(body.length),
    body,
  );
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
  body?: Uint8Array;
}) {
  const body = options.body ?? Uint8Array.of(1, 0, 0, 0);
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
  const bodyLength = readInt32Le(plaintext, 28);
  return {
    sessionId: bytesToBigInt(plaintext.slice(8, 16), {
      littleEndian: true,
      signed: true,
    }),
    messageId: bytesToBigInt(plaintext.slice(16, 24), { littleEndian: true }),
    sequenceNumber: readInt32Le(plaintext, 24),
    body: plaintext.slice(32, 32 + bodyLength),
  };
}

async function outgoingMessages(
  packet: Uint8Array,
  key: AuthKey,
  crypto: Pick<CryptoAdapter, 'sha256'>,
) {
  const outer = await outgoingHeader(packet, key, crypto);
  if (outer.body.length < 8 || readUint32Le(outer.body) !== 0x73f1f8dc) return [outer];
  const count = readInt32Le(outer.body, 4);
  const messages: Array<Pick<typeof outer, 'messageId' | 'sequenceNumber' | 'body'>> = [];
  let offset = 8;
  for (let index = 0; index < count; index += 1) {
    const messageId = bytesToBigInt(outer.body.slice(offset, offset + 8), {
      littleEndian: true,
    });
    const sequenceNumber = readInt32Le(outer.body, offset + 8);
    const bodyLength = readInt32Le(outer.body, offset + 12);
    offset += 16;
    messages.push({
      messageId,
      sequenceNumber,
      body: outer.body.slice(offset, offset + bodyLength),
    });
    offset += bodyLength;
  }
  return messages;
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
  it('rejects an unanswered request at its sender deadline', async () => {
    const sender = createMtprotoSender({
      ...senderOptions(
        () => connectionDouble(),
        codecDouble(() => Uint8Array.of(1, 0, 0, 0)),
      ),
      requestTimeoutMs: 10,
    });
    await sender.connect();

    await expect(sender.invoke({ _: 'messages.getHistory' })).rejects.toThrow(
      'Telegram request timed out',
    );
    sender.disconnect();
  });

  it('does not transmit a request that expires before the connection opens', async () => {
    let releaseConnection!: () => void;
    const connectionGate = new Promise<void>((resolve) => {
      releaseConnection = resolve;
    });
    const encodedNames: string[] = [];
    const connection = connectionDouble();
    const openConnection = connection.connect.bind(connection);
    connection.connect = async () => {
      await connectionGate;
      await openConnection();
    };
    const sender = createMtprotoSender({
      ...senderOptions(
        () => connection,
        codecDouble((value) => {
          encodedNames.push(value._);
          return Uint8Array.of(1, 0, 0, 0);
        }),
      ),
      requestTimeoutMs: 10,
    });

    const request = sender.invoke({ _: 'messages.sendMessage' });
    await expect(request).rejects.toThrow('Telegram request timed out');
    releaseConnection();
    await vi.waitFor(() => expect(sender.isConnected()).toBe(true));

    expect(encodedNames).not.toContain('messages.sendMessage');
    sender.disconnect();
  });

  it('does not transmit a request that expires while its packet is encrypting', async () => {
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
    const crypto: CryptoAdapter = {
      ...browserCrypto,
      async sha256(bytes) {
        if (blockNextHash) {
          blockNextHash = false;
          reportBlocked();
          await hashGate;
        }
        return browserCrypto.sha256(bytes);
      },
    };
    let packetsSent = 0;
    const sender = createMtprotoSender({
      ...senderOptions(
        () =>
          connectionDouble(() => {
            packetsSent += 1;
          }),
        codecDouble(() => Uint8Array.of(1, 0, 0, 0)),
      ),
      crypto,
      requestTimeoutMs: 10,
    });
    await sender.connect();
    await vi.waitFor(() => expect(packetsSent).toBeGreaterThanOrEqual(1));
    const packetsBeforeRequest = packetsSent;

    blockNextHash = true;
    const request = sender.invoke({ _: 'messages.sendMessage' });
    await blocked;
    await expect(request).rejects.toThrow('Telegram request timed out');
    releaseHash();
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));

    expect(packetsSent).toBe(packetsBeforeRequest);
    sender.disconnect();
  });

  it('does not carry an old-session acknowledgment across a disconnect during encryption', async () => {
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
    const crypto: CryptoAdapter = {
      ...browserCrypto,
      randomBytes: (length) => new Uint8Array(length).fill(1),
      async sha256(bytes) {
        if (blockNextHash) {
          blockNextHash = false;
          reportBlocked();
          await hashGate;
        }
        return browserCrypto.sha256(bytes);
      },
    };
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const packets: Uint8Array[][] = [];
    let acknowledgmentEncodes = 0;
    const codec: TlCodec = {
      encode(value) {
        if (value._ === 'msgs_ack') acknowledgmentEncodes += 1;
        return Uint8Array.of(1, 0, 0, 0);
      },
      decode: () => ({ _: 'test.update' }),
      resultTypeFor: () => undefined,
    };
    const key = authKey();
    const now = 1_700_000_000_000;
    const sender = createMtprotoSender({
      ...senderOptions(() => {
        const sent: Uint8Array[] = [];
        packets.push(sent);
        const connection = connectionDouble((packet) => sent.push(packet));
        connections.push(connection);
        return connection;
      }, codec),
      authKey: key,
      crypto,
      serverSalt: 5n,
      now: () => now,
    });
    let updateReceived = false;
    const unsubscribe = sender.subscribe((event) => {
      if (event._ === 'update') updateReceived = true;
    });
    await sender.connect();
    await vi.waitFor(() => expect(packets[0]!.length).toBeGreaterThanOrEqual(1));
    const updatePacket = await incomingPacket({
      key,
      crypto: browserCrypto,
      salt: 5n,
      sessionId: bytesToBigInt(new Uint8Array(8).fill(1), {
        littleEndian: true,
        signed: true,
      }),
      messageId: (1_700_000_000n << 32n) | 1n,
      sequenceNumber: 1,
    });
    connections[0]!.emitPacket(updatePacket);
    await vi.waitFor(() => expect(updateReceived).toBe(true));

    blockNextHash = true;
    const request = sender.invoke({ _: 'messages.getHistory' }).catch(() => undefined);
    await blocked;
    expect(acknowledgmentEncodes).toBe(2);
    sender.disconnect();
    releaseHash();
    await request;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));

    await sender.connect();
    await vi.waitFor(() => expect(packets[1]!.length).toBeGreaterThanOrEqual(1));
    expect(acknowledgmentEncodes).toBe(2);
    unsubscribe();
    sender.disconnect();
  });

  it('does not let a stalled decrypt from an old connection block its replacement', async () => {
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
    const crypto: CryptoAdapter = {
      ...browserCrypto,
      randomBytes: (length) => new Uint8Array(length).fill(1),
      async sha256(bytes) {
        if (blockNextHash) {
          blockNextHash = false;
          reportBlocked();
          await hashGate;
        }
        return browserCrypto.sha256(bytes);
      },
    };
    const targetConstructor = 0x01020304;
    const resultConstructor = 0x05060708;
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const packets: Uint8Array[][] = [];
    const key = authKey();
    const now = 1_700_000_000_000;
    const codec: TlCodec = {
      encode(value) {
        return writeUint32Le(value._ === 'messages.getHistory' ? targetConstructor : 0x11121314);
      },
      decode(bytes) {
        return readUint32Le(bytes) === resultConstructor
          ? { _: 'test.result' }
          : { _: 'test.update' };
      },
      resultTypeFor: () => undefined,
    };
    const sender = createMtprotoSender({
      ...senderOptions(() => {
        const sent: Uint8Array[] = [];
        packets.push(sent);
        const connection = connectionDouble((packet) => sent.push(packet));
        connections.push(connection);
        return connection;
      }, codec),
      authKey: key,
      crypto,
      serverSalt: 5n,
      now: () => now,
      requestTimeoutMs: 500,
      reconnect: { retries: 1, delayMs: 0 },
    });
    await sender.connect();
    await vi.waitFor(() => expect(packets[0]!.length).toBeGreaterThanOrEqual(1));
    const request = sender.invoke<TlObject>({ _: 'messages.getHistory' });
    await vi.waitFor(async () => {
      const messages = await outgoingMessages(packets[0]!.at(-1)!, key, crypto);
      expect(messages.some(({ body }) => readUint32Le(body) === targetConstructor)).toBe(true);
    });
    const stalledPacket = await incomingPacket({
      key,
      crypto: browserCrypto,
      salt: 5n,
      sessionId: bytesToBigInt(new Uint8Array(8).fill(1), {
        littleEndian: true,
        signed: true,
      }),
      messageId: (1_700_000_000n << 32n) | 1n,
      sequenceNumber: 1,
    });

    blockNextHash = true;
    connections[0]!.emitPacket(stalledPacket);
    await blocked;
    connections[0]!.disconnect();
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    await vi.waitFor(() => expect(packets[1]!.length).toBeGreaterThanOrEqual(1));
    const retriedMessages = (
      await Promise.all(packets[1]!.map((packet) => outgoingMessages(packet, key, crypto)))
    ).flat();
    const retried = retriedMessages.find(({ body }) => readUint32Le(body) === targetConstructor);
    expect(retried).toBeDefined();
    const resultBody = concatBytes(
      writeUint32Le(0xf35c6d01),
      bigIntToBytes(retried!.messageId, 8, { littleEndian: true }),
      writeUint32Le(resultConstructor),
    );
    connections[1]!.emitPacket(
      await incomingPacket({
        key,
        crypto: browserCrypto,
        salt: 5n,
        sessionId: bytesToBigInt(new Uint8Array(8).fill(1), {
          littleEndian: true,
          signed: true,
        }),
        messageId: (1_700_000_000n << 32n) | 5n,
        sequenceNumber: 1,
        body: resultBody,
      }),
    );

    await expect(request).resolves.toEqual({ _: 'test.result' });
    releaseHash();
    sender.disconnect();
  });

  it('makes a forgotten auth key terminal and rejects every request with the same -404 error', async () => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    let releaseInvalidation!: () => void;
    const invalidationGate = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });
    const invalidated = vi.fn(() => invalidationGate);
    const sender = createMtprotoSender({
      ...senderOptions(
        () => {
          const connection = connectionDouble();
          connections.push(connection);
          return connection;
        },
        codecDouble(() => Uint8Array.of(1, 0, 0, 0)),
      ),
      onAuthKeyInvalidated: invalidated,
      requestTimeoutMs: 10,
    });
    await sender.connect();
    const first = sender.invoke({ _: 'messages.getHistory' });
    const second = sender.invoke({ _: 'messages.getDialogs' });
    let firstSettled = false;
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    const results = Promise.allSettled([first, second]);

    connections[0]!.emitPacket(writeInt32Le(-404));
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
    const [firstResult, secondResult] = await results;
    expect(firstSettled).toBe(true);
    expect(firstResult.status).toBe('rejected');
    expect(secondResult.status).toBe('rejected');
    if (firstResult.status !== 'rejected' || secondResult.status !== 'rejected') return;
    expect(firstResult.reason).toBe(secondResult.reason);
    expect(firstResult.reason).toMatchObject({ kind: 'session', code: -404 });
    expect(invalidated).toHaveBeenCalledOnce();
    expect(sender.isConnected()).toBe(false);
    await expect(sender.invoke({ _: 'messages.getHistory' })).rejects.toBe(firstResult.reason);
    await expect(sender.connect()).rejects.toBe(firstResult.reason);
    await Promise.resolve();
    expect(connections).toHaveLength(1);
    releaseInvalidation();
    sender.disconnect();
  });

  it('reauthorizes and retries pending requests after a main auth key is forgotten', async () => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    let targetEncodes = 0;
    const authorize = vi.fn(async () => ({ authKey: authKey(), serverSalt: 7n, timeOffset: 0 }));
    const persisted = vi.fn();
    const sender = createMtprotoSender({
      ...senderOptions(
        () => {
          const connection = connectionDouble();
          connections.push(connection);
          return connection;
        },
        codecDouble((value) => {
          if (value._ === 'messages.getHistory') targetEncodes += 1;
          return Uint8Array.of(1, 0, 0, 0);
        }),
      ),
      authorize,
      onAuthKey: persisted,
    });
    await sender.connect();
    const request = sender.invoke({ _: 'messages.getHistory' }).catch(() => undefined);
    await vi.waitFor(() => expect(targetEncodes).toBe(2));

    connections[0]!.emitPacket(writeInt32Le(-404));

    await vi.waitFor(() => expect(connections).toHaveLength(2));
    await vi.waitFor(() => expect(targetEncodes).toBe(4));
    expect(authorize).toHaveBeenCalledOnce();
    expect(persisted).toHaveBeenCalledOnce();
    expect(sender.isConnected()).toBe(true);
    sender.disconnect();
    await request;
  });

  it('accepts an RPC result nested in an incoming message container', async () => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const packets: Uint8Array[] = [];
    const baseCrypto = createBrowserCryptoAdapter();
    const crypto: CryptoAdapter = {
      ...baseCrypto,
      randomBytes: (length) => new Uint8Array(length).fill(1),
    };
    const key = authKey();
    const now = 1_700_000_000_000;
    const codec: TlCodec = {
      encode: () => Uint8Array.of(1, 0, 0, 0),
      decode: () => ({ _: 'test.result' }),
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
      now: () => now,
    });
    await sender.connect();
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(1));

    const result = sender.invoke<TlObject>({ _: 'messages.getHistory' });
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(2));
    const sent = await outgoingHeader(packets.at(-1)!, key, crypto);
    const resultBody = concatBytes(
      writeUint32Le(0xf35c6d01),
      bigIntToBytes(sent.messageId, 8, { littleEndian: true }),
      Uint8Array.of(2, 0, 0, 0),
    );
    const innerMessageId = (1_700_000_000n << 32n) | 5n;
    const containerBody = concatBytes(
      writeUint32Le(0x73f1f8dc),
      writeInt32Le(1),
      bigIntToBytes(innerMessageId, 8, { littleEndian: true }),
      writeInt32Le(1),
      writeInt32Le(resultBody.length),
      resultBody,
    );
    connections[0]!.emitPacket(
      await incomingPacket({
        key,
        crypto,
        salt: 5n,
        sessionId: bytesToBigInt(new Uint8Array(8).fill(1), {
          littleEndian: true,
          signed: true,
        }),
        messageId: (1_700_000_000n << 32n) | 9n,
        sequenceNumber: 2,
        body: containerBody,
      }),
    );

    await expect(result).resolves.toEqual({ _: 'test.result' });
    expect(connections).toHaveLength(1);
    sender.disconnect();
  });

  it('processes and acknowledges an expired RPC result carried by msg_copy', async () => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const packets: Uint8Array[] = [];
    const acknowledgments: bigint[][] = [];
    const baseCrypto = createBrowserCryptoAdapter();
    const crypto: CryptoAdapter = {
      ...baseCrypto,
      randomBytes: (length) => new Uint8Array(length).fill(1),
    };
    const key = authKey();
    const now = 1_700_000_000_000;
    const codec: TlCodec = {
      encode(value) {
        if (value._ === 'msgs_ack') {
          acknowledgments.push((value.msgIds ?? value.msg_ids ?? []) as bigint[]);
        }
        return Uint8Array.of(1, 0, 0, 0);
      },
      decode: () => ({ _: 'test.copiedResult' }),
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
      now: () => now,
    });
    await sender.connect();
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(1));

    const result = sender.invoke<TlObject>({ _: 'messages.getHistory' });
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(2));
    const sent = await outgoingHeader(packets.at(-1)!, key, crypto);
    const rpcResult = concatBytes(
      writeUint32Le(0xf35c6d01),
      bigIntToBytes(sent.messageId, 8, { littleEndian: true }),
      writeUint32Le(0x01020304),
    );
    const originalMessageId = (1_699_999_000n << 32n) | 1n;
    const wrapperMessageId = (1_700_000_000n << 32n) | 1n;
    connections[0]!.emitPacket(
      await incomingPacket({
        key,
        crypto,
        salt: 5n,
        sessionId: bytesToBigInt(new Uint8Array(8).fill(1), {
          littleEndian: true,
          signed: true,
        }),
        messageId: wrapperMessageId,
        sequenceNumber: 0,
        body: messageCopy(originalMessageId, 1, rpcResult),
      }),
    );

    await expect(result).resolves.toEqual({ _: 'test.copiedResult' });
    await vi.waitFor(() =>
      expect(
        acknowledgments.some(
          (ids) => ids.includes(wrapperMessageId) && ids.includes(originalMessageId),
        ),
      ).toBe(true),
    );
    expect(connections).toHaveLength(1);
    sender.disconnect();
  });

  it('does not dispatch a copied update twice when its original message is known', async () => {
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
        {
          encode: () => Uint8Array.of(1, 0, 0, 0),
          decode: () => ({ _: 'test.copiedUpdate' }),
          resultTypeFor: () => undefined,
        },
      ),
      authKey: key,
      crypto,
      serverSalt: 5n,
      now: () => now,
    });
    let updates = 0;
    const unsubscribe = sender.subscribe((event) => {
      if (event._ === 'update') updates += 1;
    });
    await sender.connect();
    const originalMessageId = (1_699_999_000n << 32n) | 1n;
    const copiedUpdate = messageCopy(originalMessageId, 1, writeUint32Le(0x01020304));
    const sessionId = bytesToBigInt(new Uint8Array(8).fill(1), {
      littleEndian: true,
      signed: true,
    });
    connections[0]!.emitPacket(
      await incomingPacket({
        key,
        crypto,
        salt: 5n,
        sessionId,
        messageId: (1_700_000_000n << 32n) | 1n,
        sequenceNumber: 0,
        body: copiedUpdate,
      }),
    );
    await vi.waitFor(() => expect(updates).toBe(1));
    connections[0]!.emitPacket(
      await incomingPacket({
        key,
        crypto,
        salt: 5n,
        sessionId,
        messageId: (1_700_000_000n << 32n) | 5n,
        sequenceNumber: 0,
        body: copiedUpdate,
      }),
    );

    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    expect(updates).toBe(1);
    expect(connections).toHaveLength(1);
    unsubscribe();
    sender.disconnect();
  });

  it('finds a time correction after an opaque RPC result in the same container', async () => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const packets: Uint8Array[] = [];
    const baseCrypto = createBrowserCryptoAdapter();
    const crypto: CryptoAdapter = {
      ...baseCrypto,
      randomBytes: (length) => new Uint8Array(length).fill(1),
    };
    const key = authKey();
    const now = 1_700_000_000_000;
    let correction: TlObject | undefined;
    const codec: TlCodec = {
      encode: () => Uint8Array.of(1, 0, 0, 0),
      decode(bytes) {
        const constructorId = readUint32Le(bytes);
        if (constructorId === 0xf35c6d01) {
          throw new Error('An untyped primitive RPC result cannot be decoded as an object.');
        }
        if (constructorId === 0x2144ca19) return correction;
        return { _: 'test.result' };
      },
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
      now: () => now,
    });
    await sender.connect();
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(1));

    const result = sender.invoke<TlObject>({ _: 'messages.getHistory' });
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(2));
    const sent = await outgoingHeader(packets.at(-1)!, key, crypto);
    correction = {
      _: 'bad_msg_notification',
      badMsgId: sent.messageId,
      badMsgSeqno: sent.sequenceNumber,
      errorCode: 17,
    };
    const resultBody = concatBytes(
      writeUint32Le(0xf35c6d01),
      bigIntToBytes(sent.messageId, 8, { littleEndian: true }),
      Uint8Array.of(2, 0, 0, 0),
    );
    const futureSeconds = 1_700_000_060n;
    const firstMessageId = (futureSeconds << 32n) | 1n;
    const correctionMessageId = (futureSeconds << 32n) | 5n;
    const correctionBody = writeUint32Le(0x2144ca19);
    const containerBody = concatBytes(
      writeUint32Le(0x73f1f8dc),
      writeInt32Le(2),
      bigIntToBytes(firstMessageId, 8, { littleEndian: true }),
      writeInt32Le(1),
      writeInt32Le(resultBody.length),
      resultBody,
      bigIntToBytes(correctionMessageId, 8, { littleEndian: true }),
      writeInt32Le(2),
      writeInt32Le(correctionBody.length),
      correctionBody,
    );
    connections[0]!.emitPacket(
      await incomingPacket({
        key,
        crypto,
        salt: 5n,
        sessionId: bytesToBigInt(new Uint8Array(8).fill(1), {
          littleEndian: true,
          signed: true,
        }),
        messageId: (futureSeconds << 32n) | 9n,
        sequenceNumber: 2,
        body: containerBody,
      }),
    );

    await expect(result).resolves.toEqual({ _: 'test.result' });
    expect(connections).toHaveLength(1);
    sender.disconnect();
  });

  it('corrects outgoing message time from a valid pong and retries after a session reset', async () => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const packets: Uint8Array[] = [];
    const baseCrypto = createBrowserCryptoAdapter();
    const crypto: CryptoAdapter = {
      ...baseCrypto,
      randomBytes: (length) => new Uint8Array(length).fill(1),
    };
    const key = authKey();
    const now = 1_700_000_000_000;
    const pingId = 99n;
    let decoded: TlObject = { _: 'unused' };
    let targetEncodes = 0;
    let pingEncodes = 0;
    const codec: TlCodec = {
      encode(value) {
        if (value._ === 'messages.getHistory') targetEncodes += 1;
        if (value._ === 'ping_delay_disconnect') pingEncodes += 1;
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
      timeOffset: 60,
      now: () => now,
    });
    await sender.connect();
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(1));

    const target = sender.invoke({ _: 'messages.getHistory' }).catch(() => undefined);
    await vi.waitFor(() => expect(targetEncodes).toBe(2));
    const targetHeader = await outgoingHeader(packets.at(-1)!, key, crypto);
    expect(Number(targetHeader.messageId >> 32n)).toBe(1_700_000_060);

    const pong = sender.invoke<TlObject>({
      _: 'ping_delay_disconnect',
      pingId,
      disconnectDelay: 60,
    });
    await vi.waitFor(() => expect(pingEncodes).toBe(2));
    const pingHeader = await outgoingHeader(packets.at(-1)!, key, crypto);
    const packetsBeforePong = packets.length;
    decoded = { _: 'pong', msgId: pingHeader.messageId, pingId };
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

    await expect(pong).resolves.toEqual(decoded);
    await vi.waitFor(() => expect(targetEncodes).toBe(4));
    await vi.waitFor(() => expect(packets.length).toBeGreaterThan(packetsBeforePong));
    const correctedHeader = await outgoingHeader(packets.at(-1)!, key, crypto);
    expect(Number(correctedHeader.messageId >> 32n)).toBe(1_700_000_000);
    expect(connections).toHaveLength(1);
    sender.disconnect();
    await target;
  });

  it('dispatches an RPC result through repeated gzip wrappers', async () => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const packets: Uint8Array[] = [];
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
          const connection = connectionDouble((packet) => packets.push(packet));
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
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(1));

    const result = sender.invoke<TlObject>({ _: 'messages.getHistory' });
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(2));
    const sent = await outgoingHeader(packets.at(-1)!, key, crypto);
    const resultBody = concatBytes(
      writeUint32Le(0xf35c6d01),
      bigIntToBytes(sent.messageId, 8, { littleEndian: true }),
      Uint8Array.of(2, 0, 0, 0),
    );
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
        body: gzipPacked(gzipPacked(resultBody)),
      }),
    );

    await expect(result).resolves.toEqual({ _: 'unused' });
    expect(connections).toHaveLength(1);
    sender.disconnect();
  });

  it('reports an incoming content message as acknowledged after its ACK is sent', async () => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const packets: Uint8Array[] = [];
    const encodedNames: string[] = [];
    const stateInfos: TlObject[] = [];
    const baseCrypto = createBrowserCryptoAdapter();
    const crypto: CryptoAdapter = {
      ...baseCrypto,
      randomBytes: (length) => new Uint8Array(length).fill(1),
    };
    const key = authKey();
    const now = 1_700_000_000_000;
    const updateId = (1_700_000_000n << 32n) | 1n;
    const stateRequestId = (1_700_000_000n << 32n) | 5n;
    const updateConstructor = 0x01020304;
    const stateRequestConstructor = 0xda69fb52;
    const codec: TlCodec = {
      encode(value) {
        encodedNames.push(value._);
        if (value._ === 'msgs_state_info') stateInfos.push(value);
        return Uint8Array.of(1, 0, 0, 0);
      },
      decode(bytes) {
        return readUint32Le(bytes) === stateRequestConstructor
          ? { _: 'msgs_state_req', msgIds: [updateId] }
          : { _: 'test.update' };
      },
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
      now: () => now,
    });
    let updateReceived = false;
    const unsubscribe = sender.subscribe((event) => {
      if (event._ === 'update') updateReceived = true;
    });
    await sender.connect();
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(1));
    const packetsBeforeUpdate = packets.length;
    const sessionId = bytesToBigInt(new Uint8Array(8).fill(1), {
      littleEndian: true,
      signed: true,
    });

    connections[0]!.emitPacket(
      await incomingPacket({
        key,
        crypto,
        salt: 5n,
        sessionId,
        messageId: updateId,
        sequenceNumber: 1,
        body: writeUint32Le(updateConstructor),
      }),
    );
    await vi.waitFor(() => expect(updateReceived).toBe(true));
    const trigger = sender.invoke({ _: 'test.flushAcknowledgments' }).catch(() => undefined);
    await vi.waitFor(() => expect(encodedNames).toContain('msgs_ack'));
    await vi.waitFor(() => expect(packets.length).toBeGreaterThan(packetsBeforeUpdate));
    connections[0]!.emitPacket(
      await incomingPacket({
        key,
        crypto,
        salt: 5n,
        sessionId,
        messageId: stateRequestId,
        sequenceNumber: 3,
        body: writeUint32Le(stateRequestConstructor),
      }),
    );

    await vi.waitFor(() => expect(stateInfos.length).toBeGreaterThan(0));
    expect(Array.from(stateInfos.at(-1)!.info as Uint8Array)).toEqual([12]);
    expect(connections).toHaveLength(1);
    unsubscribe();
    sender.disconnect();
    await trigger;
  });

  it.each([
    ['an even new-session notification', writeUint32Le(0x9ec20908), 0],
    [
      'a content-related message container',
      concatBytes(writeUint32Le(0x73f1f8dc), writeInt32Le(0)),
      1,
    ],
    ['a content-related acknowledgment', writeUint32Le(0x62d6b459), 1],
    ['a content-related message copy', writeUint32Le(0xe06046b2), 1],
  ])('rejects %s', async (_name, body, sequenceNumber) => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const baseCrypto = createBrowserCryptoAdapter();
    const crypto: CryptoAdapter = {
      ...baseCrypto,
      randomBytes: (length) => new Uint8Array(length).fill(1),
    };
    const key = authKey();
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
      now: () => 1_700_000_000_000,
    });
    await sender.connect();

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
        sequenceNumber,
        body,
      }),
    );

    await vi.waitFor(() => expect(connections).toHaveLength(2));
    sender.disconnect();
  });

  it.each([
    ['msgs_ack', 0x62d6b459, 0],
    ['msgs_state_req', 0xda69fb52, 1],
    ['msg_resend_req', 0x7d861a08, 1],
  ])('rejects an oversized %s vector', async (name, constructorId, sequenceNumber) => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const baseCrypto = createBrowserCryptoAdapter();
    const crypto: CryptoAdapter = {
      ...baseCrypto,
      randomBytes: (length) => new Uint8Array(length).fill(1),
    };
    const key = authKey();
    const codec: TlCodec = {
      encode: () => Uint8Array.of(1, 0, 0, 0),
      decode: () => ({
        _: name,
        msgIds: Array.from({ length: 8_193 }, (_, index) => BigInt(index)),
      }),
      resultTypeFor: () => undefined,
    };
    const sender = createMtprotoSender({
      ...senderOptions(() => {
        const connection = connectionDouble();
        connections.push(connection);
        return connection;
      }, codec),
      authKey: key,
      crypto,
      serverSalt: 5n,
      now: () => 1_700_000_000_000,
    });
    await sender.connect();

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
        sequenceNumber,
        body: writeUint32Le(constructorId),
      }),
    );

    await vi.waitFor(() => expect(connections).toHaveLength(2));
    sender.disconnect();
  });

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

  it('keeps a transient socket reconnect internal', async () => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    let releaseReconnect!: () => void;
    const reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    const sender = createMtprotoSender(
      senderOptions(
        () => {
          const connection = connectionDouble();
          if (connections.length > 0) {
            const openConnection = connection.connect.bind(connection);
            connection.connect = async () => {
              await reconnectGate;
              await openConnection();
            };
          }
          connections.push(connection);
          return connection;
        },
        codecDouble(() => Uint8Array.of(1, 0, 0, 0)),
      ),
    );
    const states: string[] = [];
    sender.subscribe((event) => {
      if (event._ === 'connectionState') states.push(event.state);
    });

    await sender.connect();
    connections[0]!.disconnect();
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    expect(states).toEqual(['connected']);

    releaseReconnect();
    await vi.waitFor(() => expect(sender.isConnected()).toBe(true));
    expect(states).toEqual(['connected', 'connected']);
    sender.disconnect();
  });

  it('reports disconnected only after reconnect attempts fail', async () => {
    const connections: ReturnType<typeof connectionDouble>[] = [];
    const sender = createMtprotoSender({
      ...senderOptions(
        () => {
          const connection = connectionDouble();
          if (connections.length > 0) {
            connection.connect = async () => {
              throw new Error('reconnect failed');
            };
          }
          connections.push(connection);
          return connection;
        },
        codecDouble(() => Uint8Array.of(1, 0, 0, 0)),
      ),
      reconnect: { retries: 1, delayMs: 0 },
    });
    const states: string[] = [];
    sender.subscribe((event) => {
      if (event._ === 'connectionState') states.push(event.state);
    });

    await sender.connect();
    connections[0]!.disconnect();
    await vi.waitFor(() => expect(states).toEqual(['connected', 'disconnected']));
    expect(connections).toHaveLength(3);
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
