import { gunzipSync, gzipSync } from 'fflate';
import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Result,
  Fiber,
  Queue,
  Schedule,
  Stream,
  SubscriptionRef,
} from 'effect';

import {
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  readInt32Le,
  readUint32Le,
  writeInt32Le,
  writeUint32Le,
} from '../bytes';
import { randomBytes } from '../crypto';
import { createMtprotoError, errorMessage, isMtprotoError, type MtprotoError } from '../errors';
import { connectionStateEvent, makeClientEventHub, sessionGapEvent, updateEvent } from '../events';
import { createEncryptedMessageState, type EncryptedMessageState } from './encryptedState';
import type { MtprotoSender, MtprotoSenderOptions, TlObject } from './types';

const MESSAGE_CONTAINER_ID = 0x73f1f8dc;
const RPC_RESULT_ID = 0xf35c6d01;
const GZIP_PACKED_ID = 0x3072cfa1;
const RPC_ERROR_ID = 0x2144ca19;
const MSG_COPY_ID = 0xe06046b2;
const MSGS_ACK_ID = 0x62d6b459;
const NEW_SESSION_CREATED_ID = 0x9ec20908;
const MAX_CONTAINER_MESSAGES = 1_024;
const DEFAULT_RECEIVE_QUEUE_CAPACITY = 256;
const MAX_OUTGOING_CONTAINER_MESSAGES = 100;
const MAX_OUTGOING_CONTAINER_BYTES = 1_044_456 - 8;
const MAX_GZIP_BYTES = 64 * 1024 * 1024;
const MAX_GZIP_NESTING = 16;
const MAX_MESSAGE_COPY_NESTING = 16;
const MAX_ACK_IDS = 8_192;
const MAX_INCOMING_MESSAGE_HISTORY = 1_000;
const PING_INTERVAL_MS = 3_000;
const PING_TIMEOUT_MS = 5_000;
const PING_DISCONNECT_SECONDS = 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const SEQUENTIAL_REQUESTS = new Set([
  'messages.sendMessage',
  'messages.sendMedia',
  'messages.sendMultiMedia',
  'messages.forwardMessages',
  'messages.sendInlineBotResult',
]);
const TIME_CORRECTION_CODES = new Set([16, 17]);

interface PendingRequest {
  request: TlObject;
  deferred: Deferred.Deferred<unknown, MtprotoError>;
  messageId?: bigint | undefined;
  sequenceNumber?: number | undefined;
  containerId?: bigint | undefined;
  containerSequenceNumber?: number | undefined;
  dependencyMessageId?: bigint | undefined;
  dependencyRetryCount?: number | undefined;
  queued: boolean;
  settled: boolean;
  expectResponse: boolean;
}

interface IncomingMessage {
  messageId: bigint;
  sequenceNumber: number;
  body: Uint8Array;
}

interface IncomingMessageState {
  acknowledged: boolean;
  contentRelated: boolean;
  sequenceNumber: number;
}

function field<Value>(value: TlObject, camel: string, snake: string): Value | undefined {
  return (value[camel] ?? value[snake]) as Value | undefined;
}

function serializeTlBytes(bytes: Uint8Array) {
  const prefix =
    bytes.length < 254
      ? Uint8Array.of(bytes.length)
      : Uint8Array.of(
          254,
          bytes.length & 0xff,
          (bytes.length >>> 8) & 0xff,
          (bytes.length >>> 16) & 0xff,
        );
  const unpadded = concatBytes(prefix, bytes);
  const padding = (4 - (unpadded.length % 4)) % 4;
  return padding === 0 ? unpadded : concatBytes(unpadded, new Uint8Array(padding));
}

function readTlBytes(bytes: Uint8Array, offset: number) {
  if (offset >= bytes.length)
    throw createMtprotoError('protocol', 'Telegram sent truncated bytes.');
  const first = bytes[offset]!;
  const prefixLength = first < 254 ? 1 : 4;
  if (first === 255 || offset + prefixLength > bytes.length) {
    throw createMtprotoError('protocol', 'Telegram sent an invalid bytes prefix.');
  }
  const length =
    prefixLength === 1
      ? first
      : bytes[offset + 1]! | (bytes[offset + 2]! << 8) | (bytes[offset + 3]! << 16);
  const start = offset + prefixLength;
  const paddedEnd = start + length + ((4 - ((prefixLength + length) % 4)) % 4);
  if (paddedEnd > bytes.length)
    throw createMtprotoError('protocol', 'Telegram sent truncated bytes.');
  return { value: bytes.slice(start, start + length), nextOffset: paddedEnd };
}

function gzipBody(body: Uint8Array) {
  if (body.length <= 512) return body;
  const compressed = gzipSync(body);
  const wrapped = concatBytes(writeUint32Le(GZIP_PACKED_ID), serializeTlBytes(compressed));
  return wrapped.length < body.length ? wrapped : body;
}

function gunzipBody(wrapped: Uint8Array) {
  if (wrapped.length < 5 || readUint32Le(wrapped) !== GZIP_PACKED_ID) {
    throw createMtprotoError('protocol', 'Telegram sent an invalid gzip wrapper.');
  }
  const { value, nextOffset } = readTlBytes(wrapped, 4);
  if (nextOffset !== wrapped.length || value.length < 8 || value.length > MAX_GZIP_BYTES) {
    throw createMtprotoError('protocol', 'Telegram sent an invalid gzip payload.');
  }
  const outputLength = readUint32Le(value, value.length - 4);
  if (outputLength === 0 || outputLength > MAX_GZIP_BYTES) {
    throw createMtprotoError('protocol', 'Telegram gzip output is too large.');
  }
  let output: Uint8Array;
  try {
    output = gunzipSync(value, { out: new Uint8Array(outputLength + 1) });
  } catch (cause) {
    throw createMtprotoError('protocol', 'Telegram sent a corrupt gzip payload.', { cause });
  }
  if (output.length !== outputLength) {
    throw createMtprotoError('protocol', 'Telegram gzip output has an invalid length.');
  }
  return output;
}

function unpackGzipBody(body: Uint8Array) {
  let unpacked = body;
  for (let depth = 0; depth < MAX_GZIP_NESTING; depth += 1) {
    if (unpacked.length < 4 || readUint32Le(unpacked) !== GZIP_PACKED_ID) return unpacked;
    unpacked = gunzipBody(unpacked);
  }
  if (unpacked.length >= 4 && readUint32Le(unpacked) === GZIP_PACKED_ID) {
    throw createMtprotoError('protocol', 'Telegram nested gzip data too deeply.');
  }
  return unpacked;
}

function rpcError(record: TlObject, request: TlObject) {
  const code = field<number>(record, 'errorCode', 'error_code') ?? 0;
  const rpcMessage = field<string>(record, 'errorMessage', 'error_message') ?? 'UNKNOWN';
  return createMtprotoError('rpc', `${rpcMessage} (${request._})`, {
    code,
    details: { errorMessage: rpcMessage, request: request._ },
  });
}

function senderError(error: unknown): MtprotoError {
  return isMtprotoError(error)
    ? error
    : createMtprotoError('transport', errorMessage(error), { cause: error });
}

export const createMtprotoSender = Effect.fn('mtproto.sender.make')(function* (
  options: MtprotoSenderOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const runCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
    effect.pipe(Effect.provideService(Crypto.Crypto, crypto));
  const requestTimeoutMs = Math.trunc(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  if (requestTimeoutMs <= 0) {
    return yield* Effect.fail(
      createMtprotoError('configuration', 'Telegram request timeout must be positive.'),
    );
  }
  const receiveQueueCapacity = Math.trunc(
    options.receiveQueueCapacity ?? DEFAULT_RECEIVE_QUEUE_CAPACITY,
  );
  if (receiveQueueCapacity <= 0) {
    return yield* Effect.fail(
      createMtprotoError('configuration', 'Telegram receive queue capacity must be positive.'),
    );
  }
  const eventHub = yield* makeClientEventHub();
  const connectedState = yield* SubscriptionRef.make(false);
  const flushSignals = yield* Queue.dropping<void>(1);
  const outgoingPackets = yield* Queue.bounded<Uint8Array>(receiveQueueCapacity);
  const waiting: PendingRequest[] = [];
  const pendingByMessageId = new Map<bigint, PendingRequest>();
  const requestsByContainerId = new Map<bigint, PendingRequest[]>();
  const pendingAcks = new Set<bigint>();
  const incomingMessageIds: bigint[] = [];
  const incomingMessages = new Map<bigint, IncomingMessageState>();
  const copiedMessageIds: bigint[] = [];
  const copiedMessages = new Map<bigint, IncomingMessageState>();
  let encryptedState: EncryptedMessageState | undefined;
  let authKey = options.authKey;
  let serverSalt = options.serverSalt ?? 0n;
  let timeOffset = options.timeOffset ?? 0;
  let connected = false;
  let lastSessionFirstMessageId: bigint | undefined;
  let lastSessionUniqueId: bigint | undefined;
  let terminalError: unknown;

  const resetIncomingTracking = () => {
    incomingMessageIds.length = 0;
    incomingMessages.clear();
    copiedMessageIds.length = 0;
    copiedMessages.clear();
    pendingAcks.clear();
  };

  const unlink = (request: PendingRequest) => {
    if (request.queued) {
      const waitingIndex = waiting.indexOf(request);
      if (waitingIndex >= 0) waiting.splice(waitingIndex, 1);
      request.queued = false;
    }
    if (request.messageId !== undefined) pendingByMessageId.delete(request.messageId);
    if (request.containerId !== undefined) {
      const siblings = requestsByContainerId
        .get(request.containerId)
        ?.filter((item) => item !== request);
      if (siblings?.length) requestsByContainerId.set(request.containerId, siblings);
      else requestsByContainerId.delete(request.containerId);
    }
  };

  const settle = Effect.fn('mtproto.sender.settle')(function* (
    request: PendingRequest,
    result: { value?: unknown; error?: unknown },
  ) {
    if (request.settled) return;
    request.settled = true;
    unlink(request);
    if ('error' in result) {
      yield* Deferred.fail(request.deferred, senderError(result.error));
    } else {
      yield* Deferred.succeed(request.deferred, result.value);
    }
  });

  const takeRequests = (messageId: bigint) => {
    const direct = pendingByMessageId.get(messageId);
    if (direct) return [direct];
    return requestsByContainerId.get(messageId) ?? [];
  };

  const enqueue = (request: PendingRequest) => {
    if (request.settled || request.queued) return;
    request.queued = true;
    waiting.push(request);
  };

  const incomingMessageState = (messageId: bigint) => {
    if ((messageId & 1n) !== 1n) return 1;
    const known = incomingMessages.get(messageId) ?? copiedMessages.get(messageId);
    if (known) {
      return 4 + (known.contentRelated ? (known.acknowledged ? 8 : 0) : 16);
    }
    const first = incomingMessageIds[0];
    const last = incomingMessageIds.at(-1);
    if (first === undefined || messageId < first) return 1;
    if (last !== undefined && messageId > last) return 3;
    return 2;
  };

  const requeue = (requests: readonly PendingRequest[]) => {
    for (const request of requests) {
      if (request.settled) continue;
      unlink(request);
      request.messageId = undefined;
      request.sequenceNumber = undefined;
      request.containerId = undefined;
      request.containerSequenceNumber = undefined;
      request.dependencyMessageId = undefined;
      enqueue(request);
    }
    scheduleFlush();
  };

  const scheduleFlush = () => {
    Queue.offerUnsafe(flushSignals, undefined);
  };

  const flushAcks = Effect.fn('mtproto.sender.flushAcks')(function* () {
    if (pendingAcks.size === 0) return;
    const ids = [...pendingAcks].slice(0, MAX_ACK_IDS);
    for (const id of ids) pendingAcks.delete(id);
    const deferred = yield* Deferred.make<unknown, MtprotoError>();
    enqueue({
      request: { _: 'msgs_ack', msgIds: ids },
      deferred,
      queued: false,
      settled: false,
      expectResponse: false,
    });
  });

  const drain = Effect.fn('mtproto.sender.drain')(function* () {
    if (!connected || !encryptedState) return;
    yield* flushAcks();
    while (waiting.length > 0 && connected) {
      const batch: PendingRequest[] = [];
      let estimatedSize = 0;
      while (waiting.length > 0 && batch.length < MAX_OUTGOING_CONTAINER_MESSAGES) {
        const candidate = waiting[0]!;
        if (candidate.settled) {
          waiting.shift();
          candidate.queued = false;
          continue;
        }
        const encoded = yield* Effect.try({
          try: () => options.codec.encode(candidate.request),
          catch: senderError,
        }).pipe(Effect.result);
        if (Result.isFailure(encoded)) {
          waiting.shift();
          candidate.queued = false;
          yield* settle(candidate, { error: encoded.failure });
          continue;
        }
        const encodedLength = encoded.success.length + 16;
        if (batch.length > 0 && estimatedSize + encodedLength > MAX_OUTGOING_CONTAINER_BYTES) break;
        waiting.shift();
        candidate.queued = false;
        if (encodedLength > MAX_OUTGOING_CONTAINER_BYTES) {
          yield* settle(candidate, {
            error: createMtprotoError('protocol', 'Telegram request is too large.'),
          });
          continue;
        }
        batch.push(candidate);
        estimatedSize += encodedLength;
      }
      if (batch.length === 0) return;

      const activeState: EncryptedMessageState = encryptedState;
      const preparedResult = yield* Effect.try({
        try: () => {
          const prepared: ReturnType<EncryptedMessageState['prepare']>[] = [];
          let previousSequentialMessageId: bigint | undefined;
          for (const request of batch) {
            let value = request.request;
            if (SEQUENTIAL_REQUESTS.has(request.request._)) {
              if (previousSequentialMessageId !== undefined) {
                value = {
                  _: 'invokeAfterMsg',
                  msgId: previousSequentialMessageId,
                  query: request.request,
                };
                request.dependencyMessageId = previousSequentialMessageId;
              }
            }
            const body = gzipBody(options.codec.encode(value));
            const message = activeState.prepare(body, request.expectResponse);
            request.messageId = message.messageId;
            request.sequenceNumber = message.sequenceNumber;
            prepared.push(message);
            if (SEQUENTIAL_REQUESTS.has(request.request._))
              previousSequentialMessageId = message.messageId;
            if (request.expectResponse) pendingByMessageId.set(message.messageId, request);
          }

          if (prepared.length === 1) return prepared[0]!.data;
          {
            const containerBody = concatBytes(
              writeUint32Le(MESSAGE_CONTAINER_ID),
              writeInt32Le(prepared.length),
              ...prepared.map((message) => message.data),
            );
            const container = activeState.prepare(containerBody, false);
            for (const request of batch) {
              request.containerId = container.messageId;
              request.containerSequenceNumber = container.sequenceNumber;
            }
            requestsByContainerId.set(
              container.messageId,
              batch.filter(({ expectResponse }) => expectResponse),
            );
            return container.data;
          }
        },
        catch: senderError,
      }).pipe(Effect.result);
      if (Result.isFailure(preparedResult)) {
        const batchStillOwned = connected && encryptedState === activeState;
        for (const request of batch) {
          if (batchStillOwned) yield* settle(request, { error: preparedResult.failure });
        }
        continue;
      }
      const encryptedResult = yield* activeState
        .encryptPrepared(preparedResult.success)
        .pipe(Effect.result);
      if (Result.isFailure(encryptedResult)) {
        for (const request of batch) yield* settle(request, { error: encryptedResult.failure });
        continue;
      }
      const encrypted = encryptedResult.success;
      if (batch.some(({ settled }) => settled)) {
        requeue(batch);
        continue;
      }
      if (!connected || encryptedState !== activeState) {
        requeue(batch);
        return;
      }
      yield* Queue.offer(outgoingPackets, encrypted);
      for (const request of batch) {
        if (!request.expectResponse) {
          if (request.request._ === 'msgs_ack') {
            const ids = field<bigint[]>(request.request, 'msgIds', 'msg_ids') ?? [];
            for (const id of ids) {
              const incoming = incomingMessages.get(id) ?? copiedMessages.get(id);
              if (incoming?.contentRelated) incoming.acknowledged = true;
            }
          }
          yield* settle(request, { value: undefined });
        }
      }
    }
  });

  const decodeObject = (body: Uint8Array, expected?: unknown) => {
    const unpacked = unpackGzipBody(body);
    if (unpacked.length >= 4 && readUint32Le(unpacked) === MESSAGE_CONTAINER_ID) {
      throw createMtprotoError('protocol', 'Telegram sent a nested message container.');
    }
    return options.codec.decode(unpacked, expected);
  };

  const processRpcResult = Effect.fn('mtproto.sender.processRpcResult')(function* (
    body: Uint8Array,
  ) {
    if (body.length < 16) {
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram sent a truncated RPC result.'),
      );
    }
    const requestMessageId = bytesToBigInt(body.slice(4, 12), { littleEndian: true });
    const request = pendingByMessageId.get(requestMessageId);
    if (!request) return;
    const resultBody = body.slice(12);
    const decoded = yield* Effect.try({
      try: () => {
        const unpacked = unpackGzipBody(resultBody);
        if (unpacked.length >= 4 && readUint32Le(unpacked) === RPC_ERROR_ID) {
          const errorRecord = options.codec.decode(unpacked) as TlObject;
          const errorMessage = field<string>(errorRecord, 'errorMessage', 'error_message');
          if (
            errorMessage === 'MSG_WAIT_FAILED' &&
            request.dependencyMessageId !== undefined &&
            (request.dependencyRetryCount ?? 0) < 1
          ) {
            request.dependencyRetryCount = (request.dependencyRetryCount ?? 0) + 1;
            requeue([request]);
            return { _tag: 'requeued' as const };
          }
          return { _tag: 'error' as const, error: rpcError(errorRecord, request.request) };
        }
        const expected = options.codec.resultTypeFor(request.request._);
        return { _tag: 'value' as const, value: options.codec.decode(unpacked, expected) };
      },
      catch: senderError,
    }).pipe(Effect.result);
    if (Result.isFailure(decoded)) return yield* settle(request, { error: decoded.failure });
    if (decoded.success._tag === 'error')
      return yield* settle(request, { error: decoded.success.error });
    if (decoded.success._tag === 'value')
      return yield* settle(request, { value: decoded.success.value });
  });

  const containerMessages = (message: IncomingMessage) => {
    if (message.body.length < 8) {
      throw createMtprotoError('protocol', 'Telegram sent a truncated message container.');
    }
    const count = readInt32Le(message.body, 4);
    if (count < 0 || count > MAX_CONTAINER_MESSAGES) {
      throw createMtprotoError('protocol', 'Telegram sent an invalid message container count.');
    }
    let offset = 8;
    const messages: IncomingMessage[] = [];
    for (let index = 0; index < count; index += 1) {
      if (offset + 16 > message.body.length) {
        throw createMtprotoError('protocol', 'Telegram sent a truncated inner message header.');
      }
      const messageId = bytesToBigInt(message.body.slice(offset, offset + 8), {
        littleEndian: true,
      });
      const sequenceNumber = readInt32Le(message.body, offset + 8);
      const length = readInt32Le(message.body, offset + 12);
      offset += 16;
      if (
        messageId >= message.messageId ||
        length < 4 ||
        length % 4 !== 0 ||
        offset + length > message.body.length
      ) {
        throw createMtprotoError('protocol', 'Telegram sent an invalid inner message.');
      }
      const inner = message.body.slice(offset, offset + length);
      offset += length;
      if (readUint32Le(inner) === MESSAGE_CONTAINER_ID) {
        throw createMtprotoError('protocol', 'Telegram sent a nested message container.');
      }
      messages.push({ messageId, sequenceNumber, body: inner });
    }
    if (offset !== message.body.length) {
      throw createMtprotoError('protocol', 'Telegram sent trailing container data.');
    }
    return messages;
  };

  const copiedMessage = (wrapper: IncomingMessage): IncomingMessage => {
    if (wrapper.body.length < 20 || readUint32Le(wrapper.body) !== MSG_COPY_ID) {
      throw createMtprotoError('protocol', 'Telegram sent a truncated message copy.');
    }
    const messageId = bytesToBigInt(wrapper.body.slice(4, 12), { littleEndian: true });
    const sequenceNumber = readInt32Le(wrapper.body, 12);
    const length = readInt32Le(wrapper.body, 16);
    if (
      messageId >= wrapper.messageId ||
      length < 4 ||
      length % 4 !== 0 ||
      20 + length !== wrapper.body.length
    ) {
      throw createMtprotoError('protocol', 'Telegram sent an invalid message copy.');
    }
    return { messageId, sequenceNumber, body: wrapper.body.slice(20) };
  };

  const packetMessages = (message: IncomingMessage) => {
    const wasGzip = message.body.length >= 4 && readUint32Le(message.body) === GZIP_PACKED_ID;
    const body = unpackGzipBody(message.body);
    if (body.length < 4 || readUint32Le(body) !== MESSAGE_CONTAINER_ID) return [message];
    if (wasGzip) {
      throw createMtprotoError('protocol', 'Telegram gzip-wrapped a message container.');
    }
    const container = { ...message, body };
    return [...containerMessages(container), container];
  };

  const invalidSequenceOrder = (previous: number, next: number) =>
    previous > next || (previous === next && (previous & 1) === 1);

  const validateContentRelatedness = (message: IncomingMessage) => {
    const body = unpackGzipBody(message.body);
    const constructorId = readUint32Le(body);
    const contentRelated = (message.sequenceNumber & 1) === 1;
    if (
      (constructorId === NEW_SESSION_CREATED_ID && !contentRelated) ||
      (contentRelated &&
        (constructorId === MESSAGE_CONTAINER_ID ||
          constructorId === MSGS_ACK_ID ||
          constructorId === MSG_COPY_ID))
    ) {
      throw createMtprotoError('protocol', 'Telegram sent invalid message content-relatedness.');
    }
  };

  const copiedPacketMessages = (message: IncomingMessage) => {
    const packet = packetMessages(message).sort((left, right) =>
      left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0,
    );
    const ids = new Set<bigint>();
    for (const item of packet) {
      if (item.sequenceNumber < 0 || (item.messageId & 1n) !== 1n || ids.has(item.messageId)) {
        throw createMtprotoError('protocol', 'Telegram sent an invalid copied message header.');
      }
      validateContentRelatedness(item);
      ids.add(item.messageId);
    }
    for (let index = 1; index < packet.length; index += 1) {
      if (invalidSequenceOrder(packet[index - 1]!.sequenceNumber, packet[index]!.sequenceNumber)) {
        throw createMtprotoError('protocol', 'Telegram sent invalid copied message ordering.');
      }
    }
    return packet;
  };

  const rememberCopiedMessage = (message: IncomingMessage) => {
    if (incomingMessages.has(message.messageId) || copiedMessages.has(message.messageId)) return;
    copiedMessageIds.push(message.messageId);
    copiedMessages.set(message.messageId, {
      acknowledged: false,
      contentRelated: (message.sequenceNumber & 1) === 1,
      sequenceNumber: message.sequenceNumber,
    });
    while (copiedMessageIds.length > MAX_INCOMING_MESSAGE_HISTORY) {
      copiedMessages.delete(copiedMessageIds.shift()!);
    }
  };

  const rememberIncomingPacket = (message: IncomingMessage, skipTimeValidation = false) => {
    const localSeconds = Math.floor((options.now ?? Date.now)() / 1_000) + timeOffset;
    const retainedFloor = incomingMessageIds[0];
    const packet = packetMessages(message).sort((left, right) =>
      left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0,
    );
    const packetIds = new Set<bigint>();
    for (const item of packet) {
      const serverSeconds = Number(item.messageId >> 32n);
      if (
        item.sequenceNumber < 0 ||
        (item.messageId & 1n) !== 1n ||
        (!skipTimeValidation &&
          (localSeconds - serverSeconds > 300 || serverSeconds - localSeconds > 30))
      ) {
        throw createMtprotoError('protocol', 'Telegram sent an invalid inner message header.');
      }
      validateContentRelatedness(item);
      if (
        incomingMessages.has(item.messageId) ||
        copiedMessages.has(item.messageId) ||
        packetIds.has(item.messageId)
      ) {
        throw createMtprotoError('protocol', 'Telegram replayed an inner message.');
      }
      if (retainedFloor !== undefined && item.messageId < retainedFloor) {
        throw createMtprotoError('protocol', 'Telegram replayed an expired inner message.');
      }
      packetIds.add(item.messageId);
    }

    const sequenceByMessageId = new Map(
      packet.map((item) => [item.messageId, item.sequenceNumber] as const),
    );
    const orderedIds = [...incomingMessageIds, ...packetIds].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (let index = 1; index < orderedIds.length; index += 1) {
      const previousId = orderedIds[index - 1]!;
      const nextId = orderedIds[index]!;
      const previous =
        sequenceByMessageId.get(previousId) ?? incomingMessages.get(previousId)!.sequenceNumber;
      const next = sequenceByMessageId.get(nextId) ?? incomingMessages.get(nextId)!.sequenceNumber;
      if (invalidSequenceOrder(previous, next)) {
        throw createMtprotoError('protocol', 'Telegram sent invalid message sequence ordering.');
      }
    }

    incomingMessageIds.splice(0, incomingMessageIds.length, ...orderedIds);
    for (const item of packet) {
      incomingMessages.set(item.messageId, {
        acknowledged: false,
        contentRelated: (item.sequenceNumber & 1) === 1,
        sequenceNumber: item.sequenceNumber,
      });
    }
    while (incomingMessageIds.length > MAX_INCOMING_MESSAGE_HISTORY) {
      incomingMessages.delete(incomingMessageIds.shift()!);
    }
  };

  const isResponseMessageId = (message: IncomingMessage) => (message.messageId & 3n) === 1n;
  const isContentRelatedResponse = (message: IncomingMessage) =>
    isResponseMessageId(message) && (message.sequenceNumber & 1) === 1;

  const matchesPendingMessage = (messageId: bigint, sequenceNumber: number) =>
    takeRequests(messageId).some((request) =>
      request.messageId === messageId
        ? request.sequenceNumber === sequenceNumber
        : request.containerId === messageId && request.containerSequenceNumber === sequenceNumber,
    );

  const isApplicableBadMessage = (
    value: unknown,
    message: IncomingMessage,
    acceptedCodes: ReadonlySet<number>,
  ) => {
    if (!value || typeof value !== 'object' || (value as TlObject)._ !== 'bad_msg_notification') {
      return false;
    }
    const record = value as TlObject;
    const errorCode = field<number>(record, 'errorCode', 'error_code');
    const badMessageId = field<bigint>(record, 'badMsgId', 'bad_msg_id');
    const badSequenceNumber = field<number>(record, 'badMsgSeqno', 'bad_msg_seqno');
    return (
      errorCode !== undefined &&
      acceptedCodes.has(errorCode) &&
      badMessageId !== undefined &&
      badSequenceNumber !== undefined &&
      isResponseMessageId(message) &&
      matchesPendingMessage(badMessageId, badSequenceNumber)
    );
  };

  const isApplicableTimeCorrection = (value: unknown, message: IncomingMessage) => {
    return isApplicableBadMessage(value, message, TIME_CORRECTION_CODES);
  };

  const timeCorrectionKey = (value: unknown) => {
    if (!value || typeof value !== 'object' || (value as TlObject)._ !== 'bad_msg_notification') {
      return undefined;
    }
    const record = value as TlObject;
    const errorCode = field<number>(record, 'errorCode', 'error_code');
    const badMessageId = field<bigint>(record, 'badMsgId', 'bad_msg_id');
    const badSequenceNumber = field<number>(record, 'badMsgSeqno', 'bad_msg_seqno');
    return errorCode === 16 || errorCode === 17
      ? `${badMessageId}:${badSequenceNumber}:${errorCode}`
      : undefined;
  };

  const prevalidatedTimeCorrections = (message: IncomingMessage): ReadonlySet<string> => {
    const found = new Set<string>();
    const visit = (candidate: IncomingMessage) => {
      const wasGzip = candidate.body.length >= 4 && readUint32Le(candidate.body) === GZIP_PACKED_ID;
      const body = unpackGzipBody(candidate.body);
      if (body.length >= 4 && readUint32Le(body) === MESSAGE_CONTAINER_ID) {
        if (wasGzip) {
          throw createMtprotoError('protocol', 'Telegram gzip-wrapped a message container.');
        }
        for (const inner of containerMessages({ ...candidate, body })) visit(inner);
        return;
      }
      if (body.length >= 4 && readUint32Le(body) === RPC_RESULT_ID) return;
      const record = decodeObject(body);
      if (!isApplicableTimeCorrection(record, candidate)) return;
      const key = timeCorrectionKey(record);
      if (key) found.add(key);
    };
    visit(message);
    return found;
  };

  const isApplicableBadServerSalt = (
    value: unknown,
    message: IncomingMessage,
    receivedSalt?: bigint,
  ) => {
    if (!value || typeof value !== 'object' || (value as TlObject)._ !== 'bad_server_salt') {
      return false;
    }
    const record = value as TlObject;
    const errorCode = field<number>(record, 'errorCode', 'error_code');
    const badMessageId = field<bigint>(record, 'badMsgId', 'bad_msg_id');
    const badSequenceNumber = field<number>(record, 'badMsgSeqno', 'bad_msg_seqno');
    const newSalt = field<bigint>(record, 'newServerSalt', 'new_server_salt');
    return (
      errorCode === 48 &&
      badMessageId !== undefined &&
      badSequenceNumber !== undefined &&
      newSalt !== undefined &&
      (receivedSalt === undefined || newSalt === receivedSalt) &&
      isResponseMessageId(message) &&
      matchesPendingMessage(badMessageId, badSequenceNumber)
    );
  };

  const containsApplicableSaltUpdate = (
    message: IncomingMessage,
    receivedSalt: bigint,
  ): boolean => {
    const wasGzip = message.body.length >= 4 && readUint32Le(message.body) === GZIP_PACKED_ID;
    const body = unpackGzipBody(message.body);
    if (body.length >= 4 && readUint32Le(body) === MESSAGE_CONTAINER_ID) {
      if (wasGzip) {
        throw createMtprotoError('protocol', 'Telegram gzip-wrapped a message container.');
      }
      return containerMessages({ ...message, body }).some((inner) =>
        containsApplicableSaltUpdate(inner, receivedSalt),
      );
    }
    if (body.length >= 12 && readUint32Le(body) === RPC_RESULT_ID) {
      const requestMessageId = bytesToBigInt(body.slice(4, 12), { littleEndian: true });
      return isContentRelatedResponse(message) && pendingByMessageId.has(requestMessageId);
    }
    const record = options.codec.decode(body) as TlObject;
    if (isApplicableBadServerSalt(record, message, receivedSalt)) return true;
    if (record._ !== 'new_session_created') return false;
    const firstMessageId = field<bigint>(record, 'firstMsgId', 'first_msg_id');
    const uniqueId = field<bigint>(record, 'uniqueId', 'unique_id');
    const nextSalt = field<bigint>(record, 'serverSalt', 'server_salt');
    return (
      isContentRelatedResponse(message) &&
      firstMessageId !== undefined &&
      uniqueId !== undefined &&
      nextSalt === receivedSalt
    );
  };

  const processCopiedMessage: (
    wrapper: IncomingMessage,
    copyDepth: number,
  ) => Effect.Effect<void, MtprotoError> = Effect.fn('mtproto.sender.processCopiedMessage')(
    function* (wrapper: IncomingMessage, copyDepth: number) {
      if (copyDepth >= MAX_MESSAGE_COPY_NESTING) {
        throw createMtprotoError('protocol', 'Telegram nested message copies too deeply.');
      }
      const original = copiedMessage(wrapper);
      const packet = copiedPacketMessages(original);
      const receivedBefore = new Set(
        packet
          .filter(
            ({ messageId }) => incomingMessages.has(messageId) || copiedMessages.has(messageId),
          )
          .map(({ messageId }) => messageId),
      );
      pendingAcks.add(wrapper.messageId);
      pendingAcks.add(original.messageId);
      for (const item of packet) rememberCopiedMessage(item);
      if (receivedBefore.has(original.messageId)) {
        scheduleFlush();
        return;
      }
      const body = unpackGzipBody(original.body);
      if (body.length >= 4 && readUint32Le(body) === MESSAGE_CONTAINER_ID) {
        for (const inner of containerMessages({ ...original, body })) {
          if (!receivedBefore.has(inner.messageId)) {
            yield* processMessage(inner, true, copyDepth + 1);
          }
        }
      } else {
        yield* processMessage(original, true, copyDepth + 1);
      }
      scheduleFlush();
    },
  );

  const processContainer = Effect.fn('mtproto.sender.processContainer')(function* (
    message: IncomingMessage,
    skipTimeValidation: boolean,
    copyDepth: number,
    timeCorrections?: ReadonlySet<string>,
  ) {
    for (const inner of containerMessages(message)) {
      yield* processMessage(inner, skipTimeValidation, copyDepth, timeCorrections);
    }
  });

  const processMessage: (
    message: IncomingMessage,
    skipTimeValidation?: boolean,
    copyDepth?: number,
    timeCorrections?: ReadonlySet<string>,
  ) => Effect.Effect<void, MtprotoError> = Effect.fn('mtproto.sender.processMessage')(function* (
    message: IncomingMessage,
    skipTimeValidation = false,
    copyDepth = 0,
    timeCorrections?: ReadonlySet<string>,
  ) {
    if ((message.sequenceNumber & 1) === 1) pendingAcks.add(message.messageId);
    const wasGzip = message.body.length >= 4 && readUint32Le(message.body) === GZIP_PACKED_ID;
    const body = unpackGzipBody(message.body);
    const constructorId = readUint32Le(body);
    if (constructorId === MSG_COPY_ID) {
      if (wasGzip) {
        throw createMtprotoError('protocol', 'Telegram gzip-wrapped a message copy.');
      }
      yield* processCopiedMessage({ ...message, body }, copyDepth);
      return;
    }
    if (constructorId === MESSAGE_CONTAINER_ID) {
      if (wasGzip) {
        throw createMtprotoError('protocol', 'Telegram gzip-wrapped a message container.');
      }
      yield* processContainer({ ...message, body }, skipTimeValidation, copyDepth, timeCorrections);
      scheduleFlush();
      return;
    }
    if (constructorId === RPC_RESULT_ID) {
      yield* processRpcResult(body);
      scheduleFlush();
      return;
    }

    const record = decodeObject(body) as TlObject;
    if (!record || typeof record !== 'object' || typeof record._ !== 'string') return;
    if (record._ === 'msgs_ack' || record._ === 'msgs_state_req' || record._ === 'msg_resend_req') {
      const ids = field<bigint[]>(record, 'msgIds', 'msg_ids') ?? [];
      if (ids.length > MAX_ACK_IDS) {
        throw createMtprotoError('protocol', 'Telegram sent too many message IDs.');
      }
    }
    if (record._ === 'bad_server_salt') {
      if (!isApplicableBadServerSalt(record, message)) {
        throw createMtprotoError('protocol', 'Telegram sent an inapplicable bad-server-salt.');
      }
      const badMessageId = field<bigint>(record, 'badMsgId', 'bad_msg_id');
      const newSalt = field<bigint>(record, 'newServerSalt', 'new_server_salt');
      if (badMessageId !== undefined && newSalt !== undefined) {
        serverSalt = newSalt;
        encryptedState?.setServerSalt(newSalt);
        requeue(takeRequests(badMessageId));
      }
      return;
    }
    if (record._ === 'bad_msg_notification') {
      const badMessageId = field<bigint>(record, 'badMsgId', 'bad_msg_id');
      const errorCode = field<number>(record, 'errorCode', 'error_code');
      if (
        (errorCode === 16 || errorCode === 17 || errorCode === 32 || errorCode === 33) &&
        !isApplicableBadMessage(record, message, new Set([errorCode])) &&
        !timeCorrections?.has(timeCorrectionKey(record) ?? '')
      ) {
        throw createMtprotoError('protocol', 'Telegram sent an inapplicable bad-message notice.');
      }
      const requests = badMessageId === undefined ? [] : takeRequests(badMessageId);
      if (errorCode === 16 || errorCode === 17) {
        timeOffset =
          Number(message.messageId >> 32n) - Math.floor((options.now ?? Date.now)() / 1_000);
        const sessionReset = encryptedState
          ? yield* encryptedState.updateTimeOffset(message.messageId)
          : false;
        if (sessionReset) resetIncomingTracking();
        requeue(sessionReset ? [...new Set(pendingByMessageId.values())] : requests);
      } else if (errorCode === 32 || errorCode === 33) {
        if (encryptedState) yield* encryptedState.resetSession();
        resetIncomingTracking();
        requeue([...new Set(pendingByMessageId.values())]);
      } else {
        for (const request of requests) {
          yield* settle(request, {
            error: createMtprotoError(
              'protocol',
              `Telegram rejected an MTProto message (${errorCode ?? 0}).`,
            ),
          });
        }
      }
      return;
    }
    if (record._ === 'new_session_created') {
      const firstMessageId = field<bigint>(record, 'firstMsgId', 'first_msg_id');
      const uniqueId = field<bigint>(record, 'uniqueId', 'unique_id');
      const nextSalt = field<bigint>(record, 'serverSalt', 'server_salt');
      if (nextSalt !== undefined) {
        serverSalt = nextSalt;
        encryptedState?.setServerSalt(nextSalt);
      }
      if (firstMessageId !== lastSessionFirstMessageId || uniqueId !== lastSessionUniqueId) {
        lastSessionFirstMessageId = firstMessageId;
        lastSessionUniqueId = uniqueId;
        yield* eventHub.publish(sessionGapEvent(firstMessageId, uniqueId));
      }
      return;
    }
    if (record._ === 'pong') {
      const requestMessageId = field<bigint>(record, 'msgId', 'msg_id');
      if (requestMessageId !== undefined) {
        const request = pendingByMessageId.get(requestMessageId);
        if (request) {
          const receivedPingId = field<bigint>(record, 'pingId', 'ping_id');
          const expectedPingId = field<bigint>(request.request, 'pingId', 'ping_id');
          if (
            request.request._ !== 'ping_delay_disconnect' ||
            receivedPingId === undefined ||
            receivedPingId !== expectedPingId
          ) {
            return yield* Effect.fail(
              createMtprotoError('protocol', 'Telegram returned a mismatched pong.'),
            );
          }
          yield* settle(request, { value: record });
          timeOffset =
            Number(message.messageId >> 32n) - Math.floor((options.now ?? Date.now)() / 1_000);
          const sessionReset = encryptedState
            ? yield* encryptedState.updateTimeOffset(message.messageId)
            : false;
          if (sessionReset) {
            resetIncomingTracking();
            requeue([...new Set(pendingByMessageId.values())]);
          }
        }
      }
      return;
    }
    if (record._ === 'future_salts') {
      const requestMessageId = field<bigint>(record, 'reqMsgId', 'req_msg_id');
      const request =
        requestMessageId === undefined ? undefined : pendingByMessageId.get(requestMessageId);
      const requestedCount =
        request?.request._ === 'get_future_salts'
          ? field<number>(request.request, 'num', 'num')
          : undefined;
      const rawSalts = field<unknown[]>(record, 'salts', 'salts') ?? [];
      if (requestMessageId === undefined || !request) return;
      if (
        !Number.isSafeInteger(requestedCount) ||
        requestedCount! < 0 ||
        rawSalts.length > requestedCount!
      ) {
        yield* settle(request, {
          error: createMtprotoError('protocol', 'Telegram sent invalid future salts.'),
        });
        return;
      }
      const salts = rawSalts.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const salt = value as TlObject;
        const validSince = field<number>(salt, 'validSince', 'valid_since');
        const validUntil = field<number>(salt, 'validUntil', 'valid_until');
        const saltValue = field<bigint>(salt, 'salt', 'salt');
        return validSince === undefined || validUntil === undefined || saltValue === undefined
          ? []
          : [{ validSince, validUntil, salt: saltValue }];
      });
      if (salts.length !== rawSalts.length || encryptedState?.setFutureSalts(salts) !== true) {
        yield* settle(request, {
          error: createMtprotoError('protocol', 'Telegram sent invalid future salts.'),
        });
        return;
      }
      serverSalt = encryptedState.getServerSalt();
      yield* settle(request, { value: record });
      return;
    }
    if (record._ === 'msg_detailed_info' || record._ === 'msg_new_detailed_info') {
      const answerMessageId = field<bigint>(record, 'answerMsgId', 'answer_msg_id');
      if (answerMessageId !== undefined) pendingAcks.add(answerMessageId);
      scheduleFlush();
      return;
    }
    if (record._ === 'msg_resend_req') {
      const ids = field<bigint[]>(record, 'msgIds', 'msg_ids') ?? [];
      for (const id of ids) requeue(takeRequests(id));
      return;
    }
    if (record._ === 'msgs_state_req') {
      const ids = field<bigint[]>(record, 'msgIds', 'msg_ids') ?? [];
      const deferred = yield* Deferred.make<unknown, MtprotoError>();
      enqueue({
        request: {
          _: 'msgs_state_info',
          reqMsgId: message.messageId,
          info: Uint8Array.from(ids, incomingMessageState),
        },
        deferred,
        queued: false,
        settled: false,
        expectResponse: false,
      });
      scheduleFlush();
      return;
    }
    if (record._ === 'msgs_ack' || record._ === 'msgs_state_info' || record._ === 'msgs_all_info') {
      return;
    }
    yield* eventHub.publish(updateEvent(record));
  });

  let plainMessageId = 0n;
  let plainPending: Deferred.Deferred<TlObject, MtprotoError> | undefined;

  const nextPlainMessageId = () => {
    const value = (BigInt(Math.floor((options.now ?? Date.now)())) * (1n << 32n)) / 1_000n;
    const aligned = value - (value % 4n);
    plainMessageId = aligned > plainMessageId ? aligned : plainMessageId + 4n;
    return plainMessageId;
  };

  const plainTransport = {
    invoke: <Result extends TlObject = TlObject>(request: TlObject) =>
      Effect.gen(function* () {
        if (plainPending) {
          return yield* Effect.fail(
            createMtprotoError('protocol', 'Authorization key requests must run sequentially.'),
          );
        }
        const body = yield* Effect.try({
          try: () => options.codec.encode(request),
          catch: (cause) =>
            createMtprotoError('protocol', 'Could not encode authorization request.', { cause }),
        });
        if (body.length < 4 || body.length > 64 * 1024 || body.length % 4 !== 0) {
          return yield* Effect.fail(
            createMtprotoError('protocol', 'Plain MTProto request is too large.'),
          );
        }
        const deferred = yield* Deferred.make<TlObject, MtprotoError>();
        plainPending = deferred;
        yield* Queue.offer(
          outgoingPackets,
          concatBytes(
            new Uint8Array(8),
            bigIntToBytes(nextPlainMessageId(), 8, { littleEndian: true }),
            writeInt32Le(body.length),
            body,
          ),
        );
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: requestTimeoutMs,
            orElse: () =>
              Effect.fail(createMtprotoError('transport', 'Telegram key request timed out.')),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              if (plainPending === deferred) plainPending = undefined;
            }),
          ),
        ) as Effect.Effect<Result, MtprotoError>;
      }),
  };

  const processPlainPacket = Effect.fn('mtproto.sender.processPlainPacket')(function* (
    packet: Uint8Array,
  ) {
    const pending = plainPending;
    if (!pending) return;
    if (packet.length < 20 || packet.length > 20 + 64 * 1024) {
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram sent an invalid plain MTProto packet.'),
      );
    }
    const authKeyId = bytesToBigInt(packet.slice(0, 8), { littleEndian: true });
    const length = readInt32Le(packet, 16);
    if (authKeyId !== 0n || length < 4 || length % 4 !== 0 || length !== packet.length - 20) {
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram sent an invalid plain MTProto header.'),
      );
    }
    const value = yield* Effect.try({
      try: () => options.codec.decode(packet.slice(20)) as TlObject,
      catch: (cause) =>
        createMtprotoError('protocol', 'Could not decode authorization response.', { cause }),
    });
    plainPending = undefined;
    yield* Deferred.succeed(pending, value);
  });

  const processPacket = Effect.fn('mtproto.sender.processPacket')(function* (packet: Uint8Array) {
    if (!encryptedState) return yield* processPlainPacket(packet);
    const sourceState = encryptedState;
    if (packet.length === 4 && readInt32Le(packet) === -404) {
      authKey = undefined;
      encryptedState = undefined;
      const error = createMtprotoError('session', 'Telegram forgot this authorization key.', {
        code: -404,
      });
      terminalError = error;
      if (options.onAuthKeyInvalidated) {
        yield* options.onAuthKeyInvalidated().pipe(Effect.ignore);
      }
      for (const request of new Set([...pendingByMessageId.values(), ...waiting])) {
        yield* settle(request, { error });
      }
      waiting.length = 0;
      pendingByMessageId.clear();
      requestsByContainerId.clear();
      return yield* Effect.fail(error);
    }
    const message = yield* sourceState.decrypt(packet);
    const incoming = {
      messageId: message.messageId,
      sequenceNumber: message.sequenceNumber,
      body: message.body,
    };
    const timeCorrections = prevalidatedTimeCorrections(incoming);
    const canCorrectTime = message.timeInvalid && timeCorrections.size > 0;
    if (message.timeInvalid && !canCorrectTime) {
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram sent a message outside the accepted time window.'),
      );
    }
    const canUpdateSalt =
      message.saltInvalid && containsApplicableSaltUpdate(incoming, message.serverSalt);
    if (message.saltInvalid && !canUpdateSalt) {
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram sent a message with an invalid salt.'),
      );
    }
    if (canUpdateSalt) {
      serverSalt = message.serverSalt;
      sourceState.setServerSalt(message.serverSalt);
    }
    yield* Effect.try({
      try: () => rememberIncomingPacket(incoming, canCorrectTime),
      catch: senderError,
    });
    yield* processMessage(incoming, canCorrectTime, 0, timeCorrections);
  });

  const publishConnectionState = (value: boolean) =>
    Effect.all(
      [
        SubscriptionRef.set(connectedState, value),
        eventHub.publish(connectionStateEvent(value ? 'connected' : 'disconnected')),
      ],
      { discard: true },
    );

  const disconnectAttempt = Effect.fn('mtproto.sender.disconnectAttempt')(function* () {
    const wasConnected = connected;
    connected = false;
    encryptedState = undefined;
    plainPending = undefined;
    yield* Queue.clear(outgoingPackets);
    if (wasConnected) yield* publishConnectionState(false);
    requeue([...new Set(pendingByMessageId.values())]);
  });

  const runConnection = () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* options.connection.packets(Stream.fromQueue(outgoingPackets)).pipe(
          Stream.runForEach((packet) =>
            processPacket(packet).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.fail(senderError(Cause.squash(cause))),
              ),
            ),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const receiverCompletion = Fiber.join(receiver).pipe(
          Effect.andThen(
            Effect.fail(createMtprotoError('transport', 'Telegram WebSocket closed unexpectedly.')),
          ),
        );

        if (!authKey) {
          const authorization = yield* Effect.raceFirst(
            options.authorize(plainTransport),
            receiverCompletion,
          );
          authKey = authorization.authKey;
          serverSalt = authorization.serverSalt;
          timeOffset = authorization.timeOffset;
          yield* options.onAuthKey(authorization);
        }
        encryptedState = yield* runCrypto(
          createEncryptedMessageState({
            authKey,
            serverSalt,
            timeOffset,
            ...(options.now ? { now: options.now } : {}),
          }),
        );
        resetIncomingTracking();
        connected = true;
        yield* publishConnectionState(true);
        scheduleFlush();
        return yield* receiverCompletion;
      }),
    );

  const supervisor = runConnection().pipe(
    Effect.ensuring(disconnectAttempt()),
    Effect.retry({
      schedule: Schedule.exponential(options.reconnect?.delayMs ?? 1_000),
      times: options.reconnect?.retries ?? 5,
    }),
    Effect.tapError((error) =>
      Effect.gen(function* () {
        terminalError = error;
        for (const request of new Set([...pendingByMessageId.values(), ...waiting])) {
          yield* settle(request, { error });
        }
      }),
    ),
  );
  yield* supervisor.pipe(Effect.forkScoped({ startImmediately: true }));

  yield* Stream.fromQueue(flushSignals).pipe(
    Stream.runForEach(() => drain()),
    Effect.forkScoped({ startImmediately: true }),
  );

  const invoke: MtprotoSender['invoke'] = <Result = unknown>(request: TlObject) =>
    Effect.gen(function* () {
      if (terminalError !== undefined) return yield* Effect.fail(senderError(terminalError));
      const deferred = yield* Deferred.make<unknown, MtprotoError>();
      const pending: PendingRequest = {
        request,
        deferred,
        queued: false,
        settled: false,
        expectResponse: true,
      };
      enqueue(pending);
      scheduleFlush();
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: requestTimeoutMs,
          orElse: () => Effect.fail(createMtprotoError('transport', 'Telegram request timed out.')),
        }),
        Effect.onInterrupt(() =>
          settle(pending, {
            error: createMtprotoError('cancelled', 'Telegram request was cancelled.'),
          }),
        ),
      ) as Effect.Effect<Result, MtprotoError>;
    });

  const ping = Effect.gen(function* () {
    if (!connected) return;
    const pingId = bytesToBigInt(yield* runCrypto(randomBytes(8)), {
      littleEndian: true,
      signed: true,
    });
    yield* invoke({
      _: 'ping_delay_disconnect',
      pingId,
      disconnectDelay: PING_DISCONNECT_SECONDS,
    }).pipe(
      Effect.timeoutOrElse({
        duration: PING_TIMEOUT_MS,
        orElse: () => Effect.fail(createMtprotoError('transport', 'Telegram ping timed out.')),
      }),
      Effect.ignore,
    );
  }).pipe(Effect.delay(PING_INTERVAL_MS), Effect.forever);
  yield* ping.pipe(Effect.forkScoped);

  yield* SubscriptionRef.changes(connectedState).pipe(
    Stream.filter(Boolean),
    Stream.runHead,
    Effect.timeoutOrElse({
      duration: requestTimeoutMs,
      orElse: () => Effect.fail(createMtprotoError('transport', 'Telegram connection timed out.')),
    }),
  );
  return {
    dcId: options.dcId,
    connected: SubscriptionRef.get(connectedState),
    invoke,
    events: eventHub.events,
  } satisfies MtprotoSender;
});
