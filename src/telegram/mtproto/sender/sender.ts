import { gunzipSync, gzipSync } from 'fflate';

import {
  bytesToBigInt,
  concatBytes,
  readInt32Le,
  readUint32Le,
  writeInt32Le,
  writeUint32Le,
} from '../bytes';
import type { PacketConnection } from '../connection';
import { createMtprotoError } from '../errors';
import {
  connectionStateEvent,
  createMtprotoEventHub,
  sessionGapEvent,
  updateEvent,
} from '../events';
import { createEncryptedMessageState, type EncryptedMessageState } from './encryptedState';
import { createPlainMtprotoTransport } from './plain';
import type { MtprotoSender, MtprotoSenderOptions, TlObject } from './types';

const MESSAGE_CONTAINER_ID = 0x73f1f8dc;
const RPC_RESULT_ID = 0xf35c6d01;
const GZIP_PACKED_ID = 0x3072cfa1;
const RPC_ERROR_ID = 0x2144ca19;
const MSG_COPY_ID = 0xe06046b2;
const MSGS_ACK_ID = 0x62d6b459;
const NEW_SESSION_CREATED_ID = 0x9ec20908;
const MAX_CONTAINER_MESSAGES = 1_024;
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
  resolve(value: unknown): void;
  reject(error: unknown): void;
  signal?: AbortSignal | undefined;
  abort?: (() => void) | undefined;
  timeout?: ReturnType<typeof globalThis.setTimeout> | undefined;
  messageId?: bigint | undefined;
  sequenceNumber?: number | undefined;
  containerId?: bigint | undefined;
  containerSequenceNumber?: number | undefined;
  dependencyMessageId?: bigint | undefined;
  dependencyRetryCount?: number | undefined;
  sendGeneration?: number | undefined;
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

function timeout<Value>(promise: Promise<Value>, milliseconds: number, onTimeout?: () => void) {
  return new Promise<Value>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(createMtprotoError('transport', 'Telegram request timed out.'));
      onTimeout?.();
    }, milliseconds);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createMtprotoSender(options: MtprotoSenderOptions): MtprotoSender {
  const requestTimeoutMs = Math.trunc(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  if (requestTimeoutMs <= 0) {
    throw createMtprotoError('configuration', 'Telegram request timeout must be positive.');
  }
  const events = createMtprotoEventHub();
  const waiting: PendingRequest[] = [];
  const pendingByMessageId = new Map<bigint, PendingRequest>();
  const requestsByContainerId = new Map<bigint, PendingRequest[]>();
  const pendingAcks = new Set<bigint>();
  const incomingMessageIds: bigint[] = [];
  const incomingMessages = new Map<bigint, IncomingMessageState>();
  const copiedMessageIds: bigint[] = [];
  const copiedMessages = new Map<bigint, IncomingMessageState>();
  let connection: ReturnType<MtprotoSenderOptions['connection']> | undefined;
  let encryptedState: EncryptedMessageState | undefined;
  let authKey = options.authKey;
  let serverSalt = options.serverSalt ?? 0n;
  let timeOffset = options.timeOffset ?? 0;
  let connected = false;
  let connecting: Promise<void> | undefined;
  let userDisconnected = false;
  let reconnecting: Promise<void> | undefined;
  let flushScheduled = false;
  let flushing: Promise<void> | undefined;
  let receiveChain = Promise.resolve();
  let pingTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let lastSessionFirstMessageId: bigint | undefined;
  let lastSessionUniqueId: bigint | undefined;
  let connectionGeneration = 0;
  let terminalError: unknown;

  const clearPing = () => {
    if (pingTimer === undefined) return;
    globalThis.clearTimeout(pingTimer);
    pingTimer = undefined;
  };

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

  const settle = (request: PendingRequest, result: { value?: unknown; error?: unknown }) => {
    if (request.settled) return;
    request.settled = true;
    request.abort?.();
    if (request.timeout !== undefined) globalThis.clearTimeout(request.timeout);
    unlink(request);
    if ('error' in result) request.reject(result.error);
    else request.resolve(result.value);
  };

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

  const requeue = (requests: readonly PendingRequest[], ownerGeneration?: number) => {
    for (const request of requests) {
      if (ownerGeneration !== undefined && request.sendGeneration !== ownerGeneration) continue;
      if (
        !request.expectResponse &&
        ownerGeneration !== undefined &&
        ownerGeneration !== connectionGeneration
      ) {
        settle(request, {
          error: createMtprotoError('cancelled', 'Telegram connection was replaced.'),
        });
        continue;
      }
      if (request.settled || request.signal?.aborted) {
        settle(request, {
          error: createMtprotoError('cancelled', 'Telegram request was cancelled.'),
        });
        continue;
      }
      unlink(request);
      request.messageId = undefined;
      request.sequenceNumber = undefined;
      request.containerId = undefined;
      request.containerSequenceNumber = undefined;
      request.dependencyMessageId = undefined;
      request.sendGeneration = undefined;
      enqueue(request);
    }
    scheduleFlush();
  };

  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      void flush().catch(() => undefined);
    });
  };

  const flushAcks = () => {
    if (pendingAcks.size === 0) return;
    const ids = [...pendingAcks].slice(0, MAX_ACK_IDS);
    for (const id of ids) pendingAcks.delete(id);
    enqueue({
      request: { _: 'msgs_ack', msgIds: ids },
      resolve() {},
      reject() {},
      queued: false,
      settled: false,
      expectResponse: false,
    });
  };

  const flush = () => {
    if (flushing) return flushing;
    const operation = drain();
    const tracked = operation.finally(() => {
      if (flushing !== tracked) return;
      flushing = undefined;
      if (connected && waiting.length > 0) scheduleFlush();
    });
    flushing = tracked;
    return tracked;
  };

  async function drain() {
    if (!connected || !connection || !encryptedState) return;
    flushAcks();
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
        if (candidate.signal?.aborted) {
          waiting.shift();
          candidate.queued = false;
          settle(candidate, {
            error: createMtprotoError('cancelled', 'Telegram request was cancelled.'),
          });
          continue;
        }
        let encodedLength: number;
        try {
          encodedLength = options.codec.encode(candidate.request).length + 16;
        } catch (error) {
          waiting.shift();
          candidate.queued = false;
          settle(candidate, { error });
          continue;
        }
        if (batch.length > 0 && estimatedSize + encodedLength > MAX_OUTGOING_CONTAINER_BYTES) break;
        waiting.shift();
        candidate.queued = false;
        if (encodedLength > MAX_OUTGOING_CONTAINER_BYTES) {
          settle(candidate, {
            error: createMtprotoError('protocol', 'Telegram request is too large.'),
          });
          continue;
        }
        batch.push(candidate);
        estimatedSize += encodedLength;
      }
      if (batch.length === 0) return;

      const activeConnection: PacketConnection = connection;
      const activeState: EncryptedMessageState = encryptedState;
      const activeGeneration = connectionGeneration;
      let encrypted: Uint8Array;
      try {
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
          request.sendGeneration = activeGeneration;
          request.messageId = message.messageId;
          request.sequenceNumber = message.sequenceNumber;
          prepared.push(message);
          if (SEQUENTIAL_REQUESTS.has(request.request._))
            previousSequentialMessageId = message.messageId;
          if (request.expectResponse) pendingByMessageId.set(message.messageId, request);
        }

        if (prepared.length === 1) {
          encrypted = await activeState.encryptPrepared(prepared[0]!.data);
        } else {
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
          encrypted = await activeState.encryptPrepared(container.data);
        }
      } catch (error) {
        const batchStillOwned =
          connected &&
          connection === activeConnection &&
          encryptedState === activeState &&
          connectionGeneration === activeGeneration;
        for (const request of batch) {
          if (batchStillOwned || request.sendGeneration === activeGeneration) {
            settle(request, { error });
          }
        }
        continue;
      }
      if (batch.some(({ settled }) => settled)) {
        requeue(batch, activeGeneration);
        continue;
      }
      if (
        !connected ||
        connection !== activeConnection ||
        encryptedState !== activeState ||
        connectionGeneration !== activeGeneration
      ) {
        requeue(batch, activeGeneration);
        return;
      }
      try {
        activeConnection.send(encrypted);
      } catch (error) {
        for (const request of batch) {
          if (!request.expectResponse) settle(request, { error });
        }
        requeue(
          batch.filter(({ expectResponse }) => expectResponse),
          activeGeneration,
        );
        void reconnect(error);
        return;
      }
      for (const request of batch) {
        if (!request.expectResponse) {
          if (request.request._ === 'msgs_ack') {
            const ids = field<bigint[]>(request.request, 'msgIds', 'msg_ids') ?? [];
            for (const id of ids) {
              const incoming = incomingMessages.get(id) ?? copiedMessages.get(id);
              if (incoming?.contentRelated) incoming.acknowledged = true;
            }
          }
          settle(request, { value: undefined });
        }
      }
    }
  }

  const decodeObject = (body: Uint8Array, expected?: unknown) => {
    const unpacked = unpackGzipBody(body);
    if (unpacked.length >= 4 && readUint32Le(unpacked) === MESSAGE_CONTAINER_ID) {
      throw createMtprotoError('protocol', 'Telegram sent a nested message container.');
    }
    return options.codec.decode(unpacked, expected);
  };

  const processRpcResult = (body: Uint8Array) => {
    if (body.length < 16)
      throw createMtprotoError('protocol', 'Telegram sent a truncated RPC result.');
    const requestMessageId = bytesToBigInt(body.slice(4, 12), { littleEndian: true });
    const request = pendingByMessageId.get(requestMessageId);
    if (!request) return;
    const resultBody = body.slice(12);
    try {
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
          return;
        }
        settle(request, { error: rpcError(errorRecord, request.request) });
        return;
      }
      const expected = options.codec.resultTypeFor(request.request._);
      settle(request, { value: options.codec.decode(unpacked, expected) });
    } catch (error) {
      settle(request, { error });
    }
  };

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

  const containsApplicableTimeCorrection = (message: IncomingMessage): boolean => {
    const wasGzip = message.body.length >= 4 && readUint32Le(message.body) === GZIP_PACKED_ID;
    const body = unpackGzipBody(message.body);
    if (body.length >= 4 && readUint32Le(body) === MESSAGE_CONTAINER_ID) {
      if (wasGzip) {
        throw createMtprotoError('protocol', 'Telegram gzip-wrapped a message container.');
      }
      return containerMessages({ ...message, body }).some(containsApplicableTimeCorrection);
    }
    if (body.length >= 4 && readUint32Le(body) === RPC_RESULT_ID) return false;
    return isApplicableTimeCorrection(options.codec.decode(body) as TlObject, message);
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

  const processCopiedMessage = async (wrapper: IncomingMessage, copyDepth: number) => {
    if (copyDepth >= MAX_MESSAGE_COPY_NESTING) {
      throw createMtprotoError('protocol', 'Telegram nested message copies too deeply.');
    }
    const original = copiedMessage(wrapper);
    const packet = copiedPacketMessages(original);
    const receivedBefore = new Set(
      packet
        .filter(({ messageId }) => incomingMessages.has(messageId) || copiedMessages.has(messageId))
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
          await processMessage(inner, true, copyDepth + 1);
        }
      }
    } else {
      await processMessage(original, true, copyDepth + 1);
    }
    scheduleFlush();
  };

  const processContainer = async (
    message: IncomingMessage,
    skipTimeValidation: boolean,
    copyDepth: number,
  ) => {
    for (const inner of containerMessages(message)) {
      await processMessage(inner, skipTimeValidation, copyDepth);
    }
  };

  async function processMessage(
    message: IncomingMessage,
    skipTimeValidation = false,
    copyDepth = 0,
  ) {
    if ((message.sequenceNumber & 1) === 1) pendingAcks.add(message.messageId);
    const wasGzip = message.body.length >= 4 && readUint32Le(message.body) === GZIP_PACKED_ID;
    const body = unpackGzipBody(message.body);
    const constructorId = readUint32Le(body);
    if (constructorId === MSG_COPY_ID) {
      if (wasGzip) {
        throw createMtprotoError('protocol', 'Telegram gzip-wrapped a message copy.');
      }
      await processCopiedMessage({ ...message, body }, copyDepth);
      return;
    }
    if (constructorId === MESSAGE_CONTAINER_ID) {
      if (wasGzip) {
        throw createMtprotoError('protocol', 'Telegram gzip-wrapped a message container.');
      }
      await processContainer({ ...message, body }, skipTimeValidation, copyDepth);
      scheduleFlush();
      return;
    }
    if (constructorId === RPC_RESULT_ID) {
      processRpcResult(body);
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
        !isApplicableBadMessage(record, message, new Set([errorCode]))
      ) {
        throw createMtprotoError('protocol', 'Telegram sent an inapplicable bad-message notice.');
      }
      const requests = badMessageId === undefined ? [] : takeRequests(badMessageId);
      if (errorCode === 16 || errorCode === 17) {
        timeOffset =
          Number(message.messageId >> 32n) - Math.floor((options.now ?? Date.now)() / 1_000);
        const sessionReset = encryptedState?.updateTimeOffset(message.messageId) === true;
        if (sessionReset) resetIncomingTracking();
        requeue(sessionReset ? [...new Set(pendingByMessageId.values())] : requests);
      } else if (errorCode === 32 || errorCode === 33) {
        encryptedState?.resetSession();
        resetIncomingTracking();
        requeue([...new Set(pendingByMessageId.values())]);
      } else {
        for (const request of requests) {
          settle(request, {
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
        events.emit(sessionGapEvent(firstMessageId, uniqueId));
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
            throw createMtprotoError('protocol', 'Telegram returned a mismatched pong.');
          }
          settle(request, { value: record });
          timeOffset =
            Number(message.messageId >> 32n) - Math.floor((options.now ?? Date.now)() / 1_000);
          const sessionReset = encryptedState?.updateTimeOffset(message.messageId) === true;
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
        settle(request, {
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
        settle(request, {
          error: createMtprotoError('protocol', 'Telegram sent invalid future salts.'),
        });
        return;
      }
      serverSalt = encryptedState.getServerSalt();
      settle(request, { value: record });
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
      enqueue({
        request: {
          _: 'msgs_state_info',
          reqMsgId: message.messageId,
          info: Uint8Array.from(ids, incomingMessageState),
        },
        resolve() {},
        reject() {},
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
    events.emit(updateEvent(record));
  }

  const handlePacket = (
    packet: Uint8Array,
    sourceConnection: PacketConnection,
    generation: number,
  ) => {
    if (sourceConnection !== connection || generation !== connectionGeneration) return;
    const sourceState = encryptedState;
    if (!sourceState) return;
    receiveChain = receiveChain
      .then(async () => {
        if (
          sourceConnection !== connection ||
          sourceState !== encryptedState ||
          generation !== connectionGeneration
        ) {
          return;
        }
        if (packet.length === 4 && readInt32Le(packet) === -404) {
          authKey = undefined;
          const error = createMtprotoError('session', 'Telegram forgot this authorization key.', {
            code: -404,
          });
          if (!options.onAuthKeyInvalidated) throw error;
          terminalError = error;
          clearPing();
          const requests = new Set([...pendingByMessageId.values(), ...waiting]);
          try {
            void Promise.resolve(options.onAuthKeyInvalidated()).catch(() => undefined);
          } catch {
            // The authoritative -404 error must still reach every affected request.
          }
          const wasConnected = connected;
          connected = false;
          connection = undefined;
          connectionGeneration += 1;
          sourceConnection.disconnect();
          encryptedState = undefined;
          resetIncomingTracking();
          if (wasConnected) events.emit(connectionStateEvent('disconnected'));
          for (const request of requests) settle(request, { error });
          waiting.length = 0;
          pendingByMessageId.clear();
          requestsByContainerId.clear();
          return;
        }
        const message = await sourceState.decrypt(packet);
        if (
          sourceConnection !== connection ||
          sourceState !== encryptedState ||
          generation !== connectionGeneration
        ) {
          return;
        }
        const incoming = {
          messageId: message.messageId,
          sequenceNumber: message.sequenceNumber,
          body: message.body,
        };
        const canCorrectTime = message.timeInvalid && containsApplicableTimeCorrection(incoming);
        if (message.timeInvalid && !canCorrectTime) {
          throw createMtprotoError(
            'protocol',
            'Telegram sent a message outside the accepted time window.',
          );
        }
        const canUpdateSalt =
          message.saltInvalid && containsApplicableSaltUpdate(incoming, message.serverSalt);
        if (message.saltInvalid && !canUpdateSalt) {
          throw createMtprotoError('protocol', 'Telegram sent a message with an invalid salt.');
        }
        if (canUpdateSalt) {
          serverSalt = message.serverSalt;
          sourceState.setServerSalt(message.serverSalt);
        }
        rememberIncomingPacket(incoming, canCorrectTime);
        await processMessage(incoming, canCorrectTime);
      })
      .catch((error: unknown) => {
        if (sourceConnection === connection && generation === connectionGeneration) {
          void reconnect(error);
        }
      });
  };

  const startPing = () => {
    clearPing();
    const tick = async () => {
      if (!connected || userDisconnected) return;
      try {
        const pingId = bytesToBigInt(options.crypto.randomBytes(8), {
          littleEndian: true,
          signed: true,
        });
        const controller = new AbortController();
        await timeout(
          invoke(
            { _: 'ping_delay_disconnect', pingId, disconnectDelay: PING_DISCONNECT_SECONDS },
            { signal: controller.signal },
          ),
          PING_TIMEOUT_MS,
          () => controller.abort(),
        );
      } catch (error) {
        void reconnect(error);
        return;
      }
      pingTimer = globalThis.setTimeout(tick, PING_INTERVAL_MS);
    };
    pingTimer = globalThis.setTimeout(tick, PING_INTERVAL_MS);
  };

  const open = async (generation: number) => {
    const nextConnection = options.connection();
    let fullyOpened = false;
    connection = nextConnection;
    receiveChain = Promise.resolve();
    const assertCurrentConnection = () => {
      if (
        !userDisconnected &&
        generation === connectionGeneration &&
        connection === nextConnection &&
        nextConnection.isConnected()
      ) {
        return;
      }
      nextConnection.disconnect();
      throw createMtprotoError('cancelled', 'Telegram connection attempt was superseded.');
    };
    nextConnection.subscribePackets((packet) => handlePacket(packet, nextConnection, generation));
    nextConnection.subscribeState((nextConnected) => {
      if (nextConnection !== connection || nextConnected || userDisconnected || !fullyOpened) {
        return;
      }
      connected = false;
      events.emit(connectionStateEvent('disconnected'));
      void reconnect(createMtprotoError('transport', 'Telegram WebSocket disconnected.'));
    });
    await nextConnection.connect();
    assertCurrentConnection();

    if (!authKey) {
      const plain = createPlainMtprotoTransport({
        connection: nextConnection,
        codec: options.codec,
        ...(options.now ? { now: options.now } : {}),
      });
      try {
        const authorization = await options.authorize(plain);
        authKey = authorization.authKey;
        serverSalt = authorization.serverSalt;
        timeOffset = authorization.timeOffset;
        await options.onAuthKey(authorization);
        assertCurrentConnection();
      } finally {
        plain.dispose();
      }
    }
    encryptedState = createEncryptedMessageState({
      authKey,
      crypto: options.crypto,
      serverSalt,
      timeOffset,
      ...(options.now ? { now: options.now } : {}),
    });
    assertCurrentConnection();
    resetIncomingTracking();
    fullyOpened = true;
    connected = true;
    events.emit(connectionStateEvent('connected'));
    const interrupted = [...pendingByMessageId.values()].filter((request) => !request.settled);
    requestsByContainerId.clear();
    requeue(interrupted);
    startPing();
    void invoke<TlObject>({ _: 'get_future_salts', num: 32 }).catch(() => undefined);
    scheduleFlush();
  };

  const openWithRetries = async (generation: number) => {
    const retries = Math.max(0, options.reconnect?.retries ?? 5);
    const delayMs = Math.max(0, options.reconnect?.delayMs ?? 1_000);
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (userDisconnected || generation !== connectionGeneration) {
        throw createMtprotoError('cancelled', 'Telegram connection attempt was superseded.');
      }
      if (attempt > 0 && delayMs > 0) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs * attempt));
      }
      try {
        await open(generation);
        return;
      } catch (error) {
        lastError = error;
        if (userDisconnected || generation !== connectionGeneration) throw error;
        const failedConnection = connection;
        connection = undefined;
        failedConnection?.disconnect();
      }
    }
    throw lastError ?? createMtprotoError('transport', 'Telegram connection failed.');
  };

  const connect = () => {
    if (terminalError !== undefined) return Promise.reject(terminalError);
    if (connected) return Promise.resolve();
    if (connecting) return connecting;
    if (reconnecting) return reconnecting;
    userDisconnected = false;
    const generation = ++connectionGeneration;
    const operation = openWithRetries(generation);
    const tracked = operation.finally(() => {
      if (connecting === tracked) connecting = undefined;
    });
    connecting = tracked;
    return tracked;
  };

  async function reconnect(_reason: unknown) {
    if (userDisconnected || terminalError !== undefined) return;
    if (reconnecting) return reconnecting;
    clearPing();
    const wasConnected = connected;
    connected = false;
    if (wasConnected) events.emit(connectionStateEvent('disconnected'));
    const previousConnection = connection;
    connection = undefined;
    const generation = ++connectionGeneration;
    const operation = Promise.resolve().then(async () => {
      previousConnection?.disconnect();
      try {
        await openWithRetries(generation);
        return;
      } catch (lastError) {
        for (const request of [...pendingByMessageId.values(), ...waiting]) {
          settle(request, { error: lastError });
        }
        waiting.length = 0;
      }
    });
    const tracked = operation.finally(() => {
      if (reconnecting === tracked) reconnecting = undefined;
    });
    reconnecting = tracked;
    return tracked;
  }

  function invoke<Result = unknown>(
    request: TlObject,
    invokeOptions: { signal?: AbortSignal } = {},
  ) {
    if (terminalError !== undefined) return Promise.reject(terminalError);
    if (userDisconnected) {
      return Promise.reject(createMtprotoError('transport', 'Telegram sender is disconnected.'));
    }
    if (invokeOptions.signal?.aborted) {
      return Promise.reject(createMtprotoError('cancelled', 'Telegram request was cancelled.'));
    }
    return new Promise<Result>((resolve, reject) => {
      const pending: PendingRequest = {
        request,
        resolve: (value) => resolve(value as Result),
        reject,
        ...(invokeOptions.signal ? { signal: invokeOptions.signal } : {}),
        queued: false,
        settled: false,
        expectResponse: true,
      };
      if (invokeOptions.signal) {
        const abort = () =>
          settle(pending, {
            error: createMtprotoError('cancelled', 'Telegram request was cancelled.'),
          });
        invokeOptions.signal.addEventListener('abort', abort, { once: true });
        pending.abort = () => invokeOptions.signal?.removeEventListener('abort', abort);
      }
      if (!invokeOptions.signal) {
        pending.timeout = globalThis.setTimeout(
          () =>
            settle(pending, {
              error: createMtprotoError('transport', 'Telegram request timed out.'),
            }),
          requestTimeoutMs,
        );
      }
      enqueue(pending);
      if (connected) scheduleFlush();
      else void connect().catch((error: unknown) => settle(pending, { error }));
    });
  }

  return {
    dcId: options.dcId,
    connect,
    disconnect() {
      userDisconnected = true;
      connectionGeneration += 1;
      connecting = undefined;
      reconnecting = undefined;
      clearPing();
      connected = false;
      const activeConnection = connection;
      connection = undefined;
      activeConnection?.disconnect();
      encryptedState = undefined;
      resetIncomingTracking();
      const error = createMtprotoError('cancelled', 'Telegram sender disconnected.');
      const requests = new Set([...pendingByMessageId.values(), ...waiting]);
      for (const request of requests) settle(request, { error });
      waiting.length = 0;
      pendingByMessageId.clear();
      requestsByContainerId.clear();
      pendingAcks.clear();
    },
    isConnected() {
      return connected && Boolean(connection?.isConnected());
    },
    invoke,
    subscribe: (listener) => events.subscribe(listener),
  };
}
