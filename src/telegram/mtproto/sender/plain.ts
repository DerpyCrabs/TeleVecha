import { bigIntToBytes, bytesToBigInt, concatBytes, readInt32Le, writeInt32Le } from '../bytes';
import { createMtprotoError } from '../errors';
import type { PacketConnection } from '../connection';
import type { PlainMtprotoTransport, TlCodec, TlObject } from './types';

const PLAIN_HEADER_BYTES = 20;
const MAX_PLAIN_BODY_BYTES = 64 * 1024;
const MESSAGE_SCALE = 1n << 32n;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

interface PendingPlainRequest {
  resolve(value: TlObject): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

export function createPlainMtprotoTransport(options: {
  connection: PacketConnection;
  codec: TlCodec;
  now?: () => number;
  requestTimeoutMs?: number;
}): PlainMtprotoTransport {
  const now = options.now ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let lastMessageId = 0n;
  let pending: PendingPlainRequest | undefined;

  const nextMessageId = () => {
    const value = (BigInt(Math.floor(now())) * MESSAGE_SCALE) / 1_000n;
    const aligned = value - (value % 4n);
    lastMessageId = aligned > lastMessageId ? aligned : lastMessageId + 4n;
    return lastMessageId;
  };

  const unsubscribe = options.connection.subscribePackets((packet) => {
    const request = pending;
    pending = undefined;
    if (!request) return;
    globalThis.clearTimeout(request.timer);
    try {
      if (
        packet.length < PLAIN_HEADER_BYTES ||
        packet.length > PLAIN_HEADER_BYTES + MAX_PLAIN_BODY_BYTES
      ) {
        throw createMtprotoError('protocol', 'Telegram sent an invalid plain MTProto packet.');
      }
      const authKeyId = bytesToBigInt(packet.slice(0, 8), { littleEndian: true });
      const length = readInt32Le(packet, 16);
      if (
        authKeyId !== 0n ||
        length < 4 ||
        length % 4 !== 0 ||
        length !== packet.length - PLAIN_HEADER_BYTES
      ) {
        throw createMtprotoError('protocol', 'Telegram sent an invalid plain MTProto header.');
      }
      request.resolve(options.codec.decode(packet.slice(PLAIN_HEADER_BYTES)) as TlObject);
    } catch (error) {
      request.reject(error);
    }
  });
  const unsubscribeState = options.connection.subscribeState((connected) => {
    if (connected || !pending) return;
    const request = pending;
    pending = undefined;
    globalThis.clearTimeout(request.timer);
    request.reject(createMtprotoError('transport', 'Telegram disconnected during key creation.'));
  });

  return {
    invoke<Result extends TlObject = TlObject>(request: TlObject) {
      if (pending) {
        return Promise.reject(
          createMtprotoError('protocol', 'Authorization key requests must run sequentially.'),
        );
      }
      const body = options.codec.encode(request);
      if (body.length < 4 || body.length > MAX_PLAIN_BODY_BYTES || body.length % 4 !== 0) {
        return Promise.reject(
          createMtprotoError('protocol', 'Plain MTProto request is too large.'),
        );
      }
      const packet = concatBytes(
        new Uint8Array(8),
        bigIntToBytes(nextMessageId(), 8, { littleEndian: true }),
        writeInt32Le(body.length),
        body,
      );
      return new Promise<Result>((resolve, reject) => {
        const current: PendingPlainRequest = {
          resolve: (value: TlObject) => resolve(value as Result),
          reject,
          timer: globalThis.setTimeout(() => {
            if (pending !== current) return;
            pending = undefined;
            reject(createMtprotoError('transport', 'Telegram key request timed out.'));
          }, requestTimeoutMs),
        };
        pending = current;
        try {
          options.connection.send(packet);
        } catch (error) {
          pending = undefined;
          globalThis.clearTimeout(current.timer);
          reject(error);
        }
      });
    },
    dispose() {
      unsubscribe();
      unsubscribeState();
      if (!pending) return;
      const request = pending;
      pending = undefined;
      globalThis.clearTimeout(request.timer);
      request.reject(createMtprotoError('cancelled', 'Authorization key creation was cancelled.'));
    },
  };
}
