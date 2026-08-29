import { describe, expect, it } from 'vitest';

import { createAuthKey, type AuthKey } from './auth';
import {
  bigIntToBytes,
  bytesToBigInt,
  bytesToHex,
  concatBytes,
  readInt32Le,
  readUint32Le,
  writeInt32Le,
  writeUint32Le,
} from './bytes';
import { createMtprotoClient } from './client';
import type { PacketConnection } from './connection';
import {
  aesIgeDecrypt,
  aesIgeEncrypt,
  createBrowserCryptoAdapter,
  type CryptoAdapter,
} from './crypto';
import { Api, createTl, encodeTl } from './tl';

const MESSAGE_CONTAINER_ID = 0x73f1f8dc;
const RPC_RESULT_ID = 0xf35c6d01;

type OutgoingMessage = {
  messageId: bigint;
  body: Uint8Array;
};

async function outgoingPacket(
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
  const outer = {
    messageId: bytesToBigInt(plaintext.slice(16, 24), { littleEndian: true }),
    body: plaintext.slice(32, 32 + readInt32Le(plaintext, 28)),
  };
  const sessionId = bytesToBigInt(plaintext.slice(8, 16), {
    littleEndian: true,
    signed: true,
  });
  if (readUint32Le(outer.body) !== MESSAGE_CONTAINER_ID) {
    return { sessionId, messages: [outer] };
  }

  const count = readInt32Le(outer.body, 4);
  const messages: OutgoingMessage[] = [];
  let offset = 8;
  for (let index = 0; index < count; index += 1) {
    const messageId = bytesToBigInt(outer.body.slice(offset, offset + 8), {
      littleEndian: true,
    });
    const length = readInt32Le(outer.body, offset + 12);
    offset += 16;
    messages.push({ messageId, body: outer.body.slice(offset, offset + length) });
    offset += length;
  }
  return { sessionId, messages };
}

async function incomingContainer(options: {
  key: AuthKey;
  crypto: Pick<CryptoAdapter, 'sha256'>;
  salt: bigint;
  sessionId: bigint;
  messageId: bigint;
  sequenceNumber: number;
  requestMessageId: bigint;
  result: Uint8Array;
}) {
  const rpcResult = concatBytes(
    writeUint32Le(RPC_RESULT_ID),
    bigIntToBytes(options.requestMessageId, 8, { littleEndian: true }),
    options.result,
  );
  const innerMessageId = options.messageId - 4n;
  const container = concatBytes(
    writeUint32Le(MESSAGE_CONTAINER_ID),
    writeInt32Le(1),
    bigIntToBytes(innerMessageId, 8, { littleEndian: true }),
    writeInt32Le(options.sequenceNumber),
    writeInt32Le(rpcResult.length),
    rpcResult,
  );
  const inner = concatBytes(
    bigIntToBytes(options.salt, 8, { littleEndian: true, signed: true }),
    bigIntToBytes(options.sessionId, 8, { littleEndian: true, signed: true }),
    bigIntToBytes(options.messageId, 8, { littleEndian: true }),
    writeInt32Le(options.sequenceNumber + 1),
    writeInt32Le(container.length),
    container,
  );
  const paddingLength = 12 + ((16 - ((inner.length + 12) % 16)) % 16);
  const plaintext = concatBytes(inner, new Uint8Array(paddingLength));
  const large = await options.crypto.sha256(
    concatBytes(options.key.bytes.slice(96, 128), plaintext),
  );
  const messageKey = large.slice(8, 24);
  const [first, second] = await Promise.all([
    options.crypto.sha256(concatBytes(messageKey, options.key.bytes.slice(8, 44))),
    options.crypto.sha256(concatBytes(options.key.bytes.slice(48, 84), messageKey)),
  ]);
  const aesKey = concatBytes(first.slice(0, 8), second.slice(8, 24), first.slice(24, 32));
  const iv = concatBytes(second.slice(0, 8), first.slice(8, 24), second.slice(24, 32));
  return concatBytes(
    bigIntToBytes(options.key.id, 8, { littleEndian: true }),
    messageKey,
    aesIgeEncrypt(aesKey, iv, plaintext, { padding: 'none' }),
  );
}

function containsConstructor(body: Uint8Array, constructorId: number) {
  const encoded = writeUint32Le(constructorId);
  return body.some((_byte, index) =>
    encoded.every((candidate, offset) => body[index + offset] === candidate),
  );
}

function configResult() {
  return createTl('config', {
    date: 0,
    expires: 0,
    testMode: false,
    thisDc: 2,
    dcOptions: [],
    dcTxtDomainName: '',
    chatSizeMax: 0,
    megagroupSizeMax: 0,
    forwardedCountMax: 0,
    onlineUpdatePeriodMs: 0,
    offlineBlurTimeoutMs: 0,
    offlineIdleTimeoutMs: 0,
    onlineCloudTimeoutMs: 0,
    notifyCloudDelayMs: 0,
    notifyDefaultDelayMs: 0,
    pushChatPeriodMs: 0,
    pushChatLimit: 0,
    editTimeLimit: 0,
    revokeTimeLimit: 0,
    revokePmTimeLimit: 0,
    ratingEDecay: 0,
    stickersRecentLimit: 0,
    channelsReadMediaPeriod: 0,
    callReceiveTimeoutMs: 0,
    callRingTimeoutMs: 0,
    callConnectTimeoutMs: 0,
    callPacketTimeoutMs: 0,
    meUrlPrefix: '',
    captionLengthMax: 0,
    messageLengthMax: 0,
    webfileDcId: 2,
  });
}

function packetServer(options: {
  key: AuthKey;
  crypto: Pick<CryptoAdapter, 'sha256'>;
  now: number;
  response(body: Uint8Array): Uint8Array | undefined;
}) {
  const packetListeners = new Set<(packet: Uint8Array) => void>();
  const stateListeners = new Set<(connected: boolean) => void>();
  let connected = false;
  let serverMessageId = (BigInt(Math.floor(options.now / 1_000)) << 32n) | 9n;
  let serverSequenceNumber = 1;
  const connection: PacketConnection = {
    async connect() {
      connected = true;
      for (const listener of stateListeners) listener(true);
    },
    disconnect() {
      if (!connected) return;
      connected = false;
      for (const listener of stateListeners) listener(false);
    },
    isConnected: () => connected,
    send(packet) {
      void (async () => {
        const outgoing = await outgoingPacket(packet, options.key, options.crypto);
        for (const message of outgoing.messages) {
          const result = options.response(message.body);
          if (!result) continue;
          const incoming = await incomingContainer({
            key: options.key,
            crypto: options.crypto,
            salt: 0n,
            sessionId: outgoing.sessionId,
            messageId: serverMessageId,
            sequenceNumber: serverSequenceNumber,
            requestMessageId: message.messageId,
            result,
          });
          serverMessageId += 8n;
          serverSequenceNumber += 2;
          queueMicrotask(() => {
            for (const listener of packetListeners) listener(incoming);
          });
        }
      })();
    },
    subscribePackets(listener) {
      packetListeners.add(listener);
      return () => packetListeners.delete(listener);
    },
    subscribeState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
  return connection;
}

describe('MTProto client packet integration', () => {
  it('loads dialogs and history when Telegram containers each encrypted RPC result', async () => {
    const now = 1_700_000_000_000;
    const keyBytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const browserCrypto = createBrowserCryptoAdapter();
    const crypto: CryptoAdapter = {
      ...browserCrypto,
      randomBytes: (length) => new Uint8Array(length).fill(1),
    };
    const key = await createAuthKey(keyBytes, crypto);
    const connection = packetServer({
      key,
      crypto,
      now,
      response(body) {
        if (containsConstructor(body, Api.help.GetConfig.id)) return encodeTl(configResult());
        if (containsConstructor(body, Api.messages.GetDialogs.id)) {
          return encodeTl(
            Api.messages.Dialogs({ dialogs: [], messages: [], chats: [], users: [] }),
          );
        }
        if (containsConstructor(body, Api.messages.GetHistory.id)) {
          return encodeTl(
            Api.messages.Messages({ messages: [], topics: [], chats: [], users: [] }),
          );
        }
        return undefined;
      },
    });
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      session: {
        load: async () => ({ mainDcId: 2, keys: { 2: bytesToHex(keyBytes) } }),
        save: async () => undefined,
        clear: async () => undefined,
      },
      crypto,
      now: () => now,
      connectionFactory: () => connection,
      connectionRetries: 0,
      requestRetries: 0,
    });

    await client.connect();
    await expect(
      client.invoke(
        Api.messages.GetDialogs({
          offsetDate: 0,
          offsetId: 0,
          offsetPeer: Api.InputPeerEmpty(),
          limit: 100,
          hash: 0n,
        }),
      ),
    ).resolves.toEqual(Api.messages.Dialogs({ dialogs: [], messages: [], chats: [], users: [] }));
    await expect(
      client.invoke(
        Api.messages.GetHistory({
          peer: Api.InputPeerUser({ userId: 10n, accessHash: 20n }),
          offsetId: 0,
          offsetDate: 0,
          addOffset: 0,
          limit: 50,
          maxId: 0,
          minId: 0,
          hash: 0n,
        }),
      ),
    ).resolves.toEqual(Api.messages.Messages({ messages: [], topics: [], chats: [], users: [] }));
    expect(connection.isConnected()).toBe(true);
    client.disconnect();
  });

  it('downloads a same-DC avatar through a second real encrypted media sender', async () => {
    const now = 1_700_000_000_000;
    const keyBytes = Uint8Array.from({ length: 256 }, (_, index) => 255 - index);
    const browserCrypto = createBrowserCryptoAdapter();
    let randomValue = 1;
    const crypto: CryptoAdapter = {
      ...browserCrypto,
      randomBytes(length) {
        const bytes = new Uint8Array(length).fill(randomValue);
        randomValue = (randomValue % 255) + 1;
        return bytes;
      },
    };
    const key = await createAuthKey(keyBytes, crypto);
    const endpoints: Array<{ host: string; purpose: 'api' | 'media' }> = [];
    const client = createMtprotoClient({
      apiId: 1,
      apiHash: 'hash',
      session: {
        load: async () => ({ mainDcId: 2, keys: { 2: bytesToHex(keyBytes) } }),
        save: async () => undefined,
        clear: async () => undefined,
      },
      crypto,
      now: () => now,
      connectionFactory(input) {
        endpoints.push({ host: input.host, purpose: input.purpose });
        return packetServer({
          key,
          crypto,
          now,
          response(body) {
            if (containsConstructor(body, Api.help.GetConfig.id)) return encodeTl(configResult());
            if (containsConstructor(body, Api.upload.GetFile.id)) {
              return encodeTl(
                createTl('upload.file', {
                  type: createTl('storage.fileUnknown'),
                  mtime: 0,
                  bytes: Uint8Array.of(4, 5, 6),
                }),
              );
            }
            return undefined;
          },
        });
      },
      connectionRetries: 0,
      requestRetries: 0,
    });

    await client.connect();
    await expect(
      client.downloadProfilePhoto({
        _: 'user',
        id: 10n,
        accessHash: 20n,
        photo: { _: 'userProfilePhoto', photoId: 30n, dcId: 2 },
      }),
    ).resolves.toEqual(Uint8Array.of(4, 5, 6));
    expect(endpoints).toEqual([
      { host: 'zws2.web.telegram.org', purpose: 'api' },
      { host: 'zws2-1.web.telegram.org', purpose: 'media' },
    ]);
    client.disconnect();
  });
});
