import {
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  equalBytesConstantTime,
  readInt32Le,
  writeInt32Le,
} from '../bytes';
import type { AuthKey } from '../auth';
import { aesIgeDecrypt, aesIgeEncrypt, type CryptoAdapter } from '../crypto';
import { createMtprotoError } from '../errors';

const EXTERNAL_HEADER_BYTES = 24;
const ENCRYPTED_HEADER_BYTES = 32;
const MIN_PADDING_BYTES = 12;
const MAX_PADDING_BYTES = 1024;
const MAX_REMOTE_MESSAGE_IDS = 1_000;
const MESSAGE_ALIGNMENT = 4n;
const MESSAGE_SCALE = 1n << 32n;
const MAX_PAST_SECONDS = 300;
const MAX_FUTURE_SECONDS = 30;
const SERVER_SALT_VALIDITY_SECONDS = 30 * 60;
const SERVER_SALT_GRACE_SECONDS = 30 * 60;

interface ServerSaltWindow {
  salt: bigint;
  validSince: number;
  validUntil: number;
  graceUntil?: number | undefined;
}

export interface DecryptedMessage {
  messageId: bigint;
  sequenceNumber: number;
  contentRelated: boolean;
  body: Uint8Array;
  timeInvalid: boolean;
  serverSalt: bigint;
  saltInvalid: boolean;
}

export interface EncryptedMessageState {
  prepare(
    this: void,
    body: Uint8Array,
    contentRelated: boolean,
  ): {
    data: Uint8Array;
    messageId: bigint;
    sequenceNumber: number;
  };
  encryptPrepared(this: void, data: Uint8Array): Promise<Uint8Array>;
  encrypt(
    this: void,
    body: Uint8Array,
    contentRelated: boolean,
  ): Promise<{
    packet: Uint8Array;
    messageId: bigint;
    sequenceNumber: number;
  }>;
  decrypt(this: void, packet: Uint8Array): Promise<DecryptedMessage>;
  setServerSalt(this: void, salt: bigint): void;
  setFutureSalts(
    this: void,
    salts: readonly { salt: bigint; validSince: number; validUntil: number }[],
  ): boolean;
  getServerSalt(this: void): bigint;
  setTimeOffset(this: void, offsetSeconds: number): void;
  updateTimeOffset(this: void, serverMessageId: bigint): boolean;
  resetSession(this: void): void;
}

function encryptedKeyMaterial(
  authKey: Uint8Array,
  messageKey: Uint8Array,
  incoming: boolean,
  crypto: Pick<CryptoAdapter, 'sha256'>,
) {
  const x = incoming ? 8 : 0;
  return Promise.all([
    crypto.sha256(concatBytes(messageKey, authKey.slice(x, x + 36))),
    crypto.sha256(concatBytes(authKey.slice(40 + x, 76 + x), messageKey)),
  ]).then(([first, second]) => ({
    key: concatBytes(first.slice(0, 8), second.slice(8, 24), first.slice(24, 32)),
    iv: concatBytes(second.slice(0, 8), first.slice(8, 24), second.slice(24, 32)),
  }));
}

function sessionId(crypto: Pick<CryptoAdapter, 'randomBytes'>) {
  return bytesToBigInt(crypto.randomBytes(8), { littleEndian: true, signed: true });
}

export function createEncryptedMessageState(options: {
  authKey: AuthKey;
  crypto: Pick<CryptoAdapter, 'randomBytes' | 'sha256'>;
  now?: () => number;
  serverSalt?: bigint;
  timeOffset?: number;
}): EncryptedMessageState {
  const now = options.now ?? Date.now;
  let currentSessionId = sessionId(options.crypto);
  let serverSalt = options.serverSalt ?? 0n;
  let timeOffset = options.timeOffset ?? 0;
  const initialServerTime = Math.floor(now() / 1_000) + timeOffset;
  let saltWindows: ServerSaltWindow[] = [
    {
      salt: serverSalt,
      validSince: initialServerTime - SERVER_SALT_VALIDITY_SECONDS,
      validUntil: initialServerTime + SERVER_SALT_VALIDITY_SECONDS,
    },
  ];
  let sequence = 0;
  let lastMessageId = 0n;
  const remoteMessageIds: bigint[] = [];
  const remoteMessageSet = new Set<bigint>();

  const nextMessageId = () => {
    const adjustedMilliseconds = BigInt(Math.floor(now())) + BigInt(timeOffset) * 1_000n;
    let messageId = (adjustedMilliseconds * MESSAGE_SCALE) / 1_000n;
    messageId -= messageId % MESSAGE_ALIGNMENT;
    if (messageId <= lastMessageId) messageId = lastMessageId + MESSAGE_ALIGNMENT;
    if ((messageId & (MESSAGE_SCALE - 1n)) === 0n) messageId += MESSAGE_ALIGNMENT;
    lastMessageId = messageId;
    return messageId;
  };

  const rememberRemoteMessage = (messageId: bigint) => {
    const retainedFloor = remoteMessageIds[0];
    if (
      remoteMessageSet.has(messageId) ||
      (retainedFloor !== undefined && messageId < retainedFloor)
    ) {
      throw createMtprotoError('protocol', 'Telegram replayed an encrypted message.');
    }
    let start = 0;
    let end = remoteMessageIds.length;
    while (start < end) {
      const middle = (start + end) >> 1;
      if (remoteMessageIds[middle]! < messageId) start = middle + 1;
      else end = middle;
    }
    remoteMessageSet.add(messageId);
    remoteMessageIds.splice(start, 0, messageId);
    if (remoteMessageIds.length <= MAX_REMOTE_MESSAGE_IDS) return;
    const removed = remoteMessageIds.splice(
      0,
      remoteMessageIds.length - MAX_REMOTE_MESSAGE_IDS / 2,
    );
    for (const id of removed) remoteMessageSet.delete(id);
  };

  const resetSession = () => {
    currentSessionId = sessionId(options.crypto);
    sequence = 0;
    lastMessageId = 0n;
    remoteMessageIds.length = 0;
    remoteMessageSet.clear();
  };

  const selectServerSalt = () => {
    const serverTime = Math.floor(now() / 1_000) + timeOffset;
    saltWindows = saltWindows.filter(
      ({ validUntil, graceUntil }) =>
        validUntil > serverTime || (graceUntil !== undefined && graceUntil > serverTime),
    );
    for (let index = saltWindows.length - 1; index >= 0; index -= 1) {
      const candidate = saltWindows[index]!;
      if (candidate.validSince <= serverTime && serverTime < candidate.validUntil) {
        if (candidate.salt !== serverSalt) {
          const previous = saltWindows.find(({ salt }) => salt === serverSalt);
          if (previous) {
            previous.validUntil = Math.min(previous.validUntil, serverTime);
            previous.graceUntil = serverTime + SERVER_SALT_GRACE_SECONDS;
          }
        }
        serverSalt = candidate.salt;
        break;
      }
    }
  };

  const isServerSaltValid = (salt: bigint, serverTime: number) =>
    saltWindows.some(
      (candidate) =>
        candidate.salt === salt &&
        ((candidate.validSince <= serverTime && serverTime < candidate.validUntil) ||
          (candidate.graceUntil !== undefined && serverTime < candidate.graceUntil)),
    );

  const prepare: EncryptedMessageState['prepare'] = (body, contentRelated) => {
    if (body.length === 0 || body.length % 4 !== 0) {
      throw createMtprotoError('protocol', 'An MTProto message body must be four-byte aligned.');
    }
    const messageId = nextMessageId();
    const sequenceNumber = contentRelated ? sequence++ * 2 + 1 : sequence * 2;
    return {
      data: concatBytes(
        bigIntToBytes(messageId, 8, { littleEndian: true }),
        writeInt32Le(sequenceNumber),
        writeInt32Le(body.length),
        body,
      ),
      messageId,
      sequenceNumber,
    };
  };

  const encryptPrepared: EncryptedMessageState['encryptPrepared'] = async (data) => {
    selectServerSalt();
    const inner = concatBytes(
      bigIntToBytes(serverSalt, 8, { littleEndian: true, signed: true }),
      bigIntToBytes(currentSessionId, 8, { littleEndian: true, signed: true }),
      data,
    );
    const paddingLength =
      MIN_PADDING_BYTES + ((16 - ((inner.length + MIN_PADDING_BYTES) % 16)) % 16);
    const plaintext = concatBytes(inner, options.crypto.randomBytes(paddingLength));
    const messageKeyLarge = await options.crypto.sha256(
      concatBytes(options.authKey.bytes.slice(88, 120), plaintext),
    );
    const messageKey = messageKeyLarge.slice(8, 24);
    const material = await encryptedKeyMaterial(
      options.authKey.bytes,
      messageKey,
      false,
      options.crypto,
    );
    const ciphertext = aesIgeEncrypt(material.key, material.iv, plaintext, { padding: 'none' });
    return concatBytes(
      bigIntToBytes(options.authKey.id, 8, { littleEndian: true }),
      messageKey,
      ciphertext,
    );
  };

  const encrypt: EncryptedMessageState['encrypt'] = async (body, contentRelated) => {
    const prepared = prepare(body, contentRelated);
    return {
      packet: await encryptPrepared(prepared.data),
      messageId: prepared.messageId,
      sequenceNumber: prepared.sequenceNumber,
    };
  };

  const decrypt: EncryptedMessageState['decrypt'] = async (packet) => {
    if (
      packet.length < EXTERNAL_HEADER_BYTES + 16 ||
      (packet.length - EXTERNAL_HEADER_BYTES) % 16 !== 0
    ) {
      throw createMtprotoError('protocol', 'Telegram sent an invalid encrypted packet length.');
    }
    const keyId = bytesToBigInt(packet.slice(0, 8), { littleEndian: true });
    const messageKey = packet.slice(8, 24);
    const material = await encryptedKeyMaterial(
      options.authKey.bytes,
      messageKey,
      true,
      options.crypto,
    );
    let plaintext: Uint8Array;
    try {
      plaintext = aesIgeDecrypt(material.key, material.iv, packet.slice(EXTERNAL_HEADER_BYTES));
    } catch (cause) {
      throw createMtprotoError('protocol', 'Telegram sent an invalid encrypted packet.', { cause });
    }
    const expectedLarge = await options.crypto.sha256(
      concatBytes(options.authKey.bytes.slice(96, 128), plaintext),
    );
    if (
      keyId !== options.authKey.id ||
      !equalBytesConstantTime(messageKey, expectedLarge.slice(8, 24))
    ) {
      throw createMtprotoError('protocol', 'Telegram encrypted-message authentication failed.');
    }
    if (plaintext.length < ENCRYPTED_HEADER_BYTES) {
      throw createMtprotoError('protocol', 'Telegram sent a truncated encrypted message.');
    }
    const receivedSalt = bytesToBigInt(plaintext.slice(0, 8), {
      littleEndian: true,
      signed: true,
    });
    const receivedSession = bytesToBigInt(plaintext.slice(8, 16), {
      littleEndian: true,
      signed: true,
    });
    const messageId = bytesToBigInt(plaintext.slice(16, 24), { littleEndian: true });
    const sequenceNumber = readInt32Le(plaintext, 24);
    const bodyLength = readInt32Le(plaintext, 28);
    const paddingLength = plaintext.length - ENCRYPTED_HEADER_BYTES - bodyLength;
    if (
      receivedSession !== currentSessionId ||
      bodyLength < 4 ||
      bodyLength % 4 !== 0 ||
      bodyLength > plaintext.length - ENCRYPTED_HEADER_BYTES ||
      paddingLength < MIN_PADDING_BYTES ||
      paddingLength > MAX_PADDING_BYTES ||
      sequenceNumber < 0 ||
      (messageId & 1n) !== 1n
    ) {
      throw createMtprotoError('protocol', 'Telegram sent an invalid encrypted message header.');
    }
    const serverSeconds = Number(messageId >> 32n);
    const localSeconds = Math.floor(now() / 1_000) + timeOffset;
    const timeInvalid =
      localSeconds - serverSeconds > MAX_PAST_SECONDS ||
      serverSeconds - localSeconds > MAX_FUTURE_SECONDS;
    const saltInvalid = !isServerSaltValid(receivedSalt, serverSeconds);
    rememberRemoteMessage(messageId);
    return {
      messageId,
      sequenceNumber,
      contentRelated: (sequenceNumber & 1) === 1,
      body: plaintext.slice(ENCRYPTED_HEADER_BYTES, ENCRYPTED_HEADER_BYTES + bodyLength),
      timeInvalid,
      serverSalt: receivedSalt,
      saltInvalid,
    };
  };

  const setServerSalt = (salt: bigint) => {
    const serverTime = Math.floor(now() / 1_000) + timeOffset;
    if (salt !== serverSalt) {
      const previous = saltWindows.find((candidate) => candidate.salt === serverSalt);
      if (previous) {
        previous.validUntil = Math.min(previous.validUntil, serverTime);
        previous.graceUntil = serverTime + SERVER_SALT_GRACE_SECONDS;
      }
    }
    serverSalt = salt;
    const known = saltWindows.find((candidate) => candidate.salt === salt);
    if (known) {
      known.validSince = Math.min(known.validSince, serverTime);
      known.validUntil = Math.max(known.validUntil, serverTime + SERVER_SALT_VALIDITY_SECONDS);
    } else {
      saltWindows.push({
        salt,
        validSince: serverTime,
        validUntil: serverTime + SERVER_SALT_VALIDITY_SECONDS,
      });
    }
  };
  const setFutureSalts: EncryptedMessageState['setFutureSalts'] = (salts) => {
    if (
      salts.length > 64 ||
      salts.some(
        ({ validSince, validUntil }) =>
          !Number.isSafeInteger(validSince) ||
          !Number.isSafeInteger(validUntil) ||
          validSince >= validUntil,
      )
    ) {
      return false;
    }
    const serverTime = Math.floor(now() / 1_000) + timeOffset;
    const retained = saltWindows.filter(
      (known) =>
        (known.salt === serverSalt ||
          (known.graceUntil !== undefined && known.graceUntil > serverTime)) &&
        !salts.some((candidate) => candidate.salt === known.salt),
    );
    saltWindows = [...retained, ...salts]
      .sort((left, right) => left.validSince - right.validSince)
      .slice(-64);
    selectServerSalt();
    return true;
  };
  const getServerSalt = () => serverSalt;
  const setTimeOffset = (offsetSeconds: number) => {
    timeOffset = Math.trunc(offsetSeconds);
  };
  const updateTimeOffset = (serverMessageId: bigint) => {
    const next = Number(serverMessageId >> 32n) - Math.floor(now() / 1_000);
    if (next === timeOffset) return false;
    const movedBackwards = next < timeOffset;
    timeOffset = next;
    if (movedBackwards) resetSession();
    return movedBackwards;
  };

  return {
    prepare,
    encryptPrepared,
    encrypt,
    decrypt,
    setServerSalt,
    setFutureSalts,
    getServerSalt,
    setTimeOffset,
    updateTimeOffset,
    resetSession,
  };
}
