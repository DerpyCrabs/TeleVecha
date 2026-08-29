import { concatBytes } from '../bytes';
import { createMtprotoError } from '../errors';
import type { TlObject } from '../sender';
import type { DownloadFileOptions, FileRpc } from './types';

const KIB = 1_024;
const MIN_PART_BYTES = 4 * KIB;
const ONE_MIB = 1_024 * 1_024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_ATTEMPTS = 2;
const MAX_ACTIVE_PARTS_PER_DC = 3;
const MAX_ACTIVE_BYTES_PER_DC = 9 * ONE_MIB;

type CapacityWaiter = {
  bytes: number;
  resolve(release: () => void): void;
};

type DcTransferCapacity = {
  activeParts: number;
  activeBytes: number;
  waiters: CapacityWaiter[];
};

const fileTransferCapacityByDc = new Map<number, DcTransferCapacity>();

function drainCapacity(dcId: number, capacity: DcTransferCapacity) {
  while (capacity.waiters.length && capacity.activeParts < MAX_ACTIVE_PARTS_PER_DC) {
    const waiter = capacity.waiters[0]!;
    if (capacity.activeBytes + waiter.bytes > MAX_ACTIVE_BYTES_PER_DC) return;
    capacity.waiters.shift();
    capacity.activeParts += 1;
    capacity.activeBytes += waiter.bytes;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      capacity.activeParts -= 1;
      capacity.activeBytes -= waiter.bytes;
      drainCapacity(dcId, capacity);
      if (!capacity.activeParts && !capacity.waiters.length) {
        fileTransferCapacityByDc.delete(dcId);
      }
    });
  }
}

export function reserveFileTransferCapacity(dcId: number, bytes: number) {
  let capacity = fileTransferCapacityByDc.get(dcId);
  if (!capacity) {
    capacity = { activeParts: 0, activeBytes: 0, waiters: [] };
    fileTransferCapacityByDc.set(dcId, capacity);
  }
  return new Promise<() => void>((resolve) => {
    capacity.waiters.push({ bytes, resolve });
    drainCapacity(dcId, capacity);
  });
}

function downloadPartSize(fileSize: number | undefined) {
  if (fileSize === undefined || fileSize <= 64 * KIB) return 64 * KIB;
  if (fileSize <= 100 * ONE_MIB) return 128 * KIB;
  if (fileSize <= 750 * ONE_MIB) return 256 * KIB;
  if (fileSize <= 2_000 * ONE_MIB) return 512 * KIB;
  if (fileSize <= 4_000 * ONE_MIB) return ONE_MIB;
  throw createMtprotoError('configuration', 'Telegram downloads cannot exceed 4,000 MiB.');
}

function resultBytes(result: unknown) {
  if (!result || typeof result !== 'object') {
    throw createMtprotoError('protocol', 'Telegram returned no file bytes.');
  }
  const record = result as TlObject;
  if (record._ === 'upload.fileCdnRedirect') {
    throw createMtprotoError('configuration', 'Telegram CDN redirects are not supported.');
  }
  if (record._ !== 'upload.file' || !(record.bytes instanceof Uint8Array)) {
    throw createMtprotoError('protocol', 'Telegram returned an unexpected file response.');
  }
  return record.bytes;
}

async function requestPart(
  rpc: FileRpc,
  dcId: number,
  request: TlObject,
  requestTimeoutMs: number,
  isCanceled: () => boolean,
) {
  const requestBytes = typeof request.limit === 'number' ? request.limit : 0;
  const release = await reserveFileTransferCapacity(dcId, requestBytes);
  try {
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
      if (isCanceled()) throw createMtprotoError('cancelled', 'Telegram download was cancelled.');
      const controller = new AbortController();
      const timer = globalThis.setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        return await rpc.invokeOnDc<unknown>(dcId, request, { signal: controller.signal });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        if (attempt + 1 < REQUEST_ATTEMPTS) {
          await rpc.recoverDc?.(dcId);
          continue;
        }
        throw createMtprotoError('transport', 'Telegram file-part request timed out.', {
          cause: error,
        });
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    throw createMtprotoError('transport', 'Telegram file-part request timed out.');
  } finally {
    release();
  }
}

export async function downloadFile(rpc: FileRpc, location: TlObject, options: DownloadFileOptions) {
  const start = Math.max(0, Math.trunc(options.start ?? 0));
  const fileFinalByte =
    options.fileSize === undefined ? undefined : Math.trunc(options.fileSize) - 1;
  const requestedFinalByte = options.end === undefined ? undefined : Math.trunc(options.end);
  const finalByte =
    requestedFinalByte === undefined
      ? fileFinalByte
      : fileFinalByte === undefined
        ? requestedFinalByte
        : Math.min(requestedFinalByte, fileFinalByte);
  if (finalByte !== undefined && finalByte < start) return new Uint8Array(0);
  const rangeSize = finalByte === undefined ? undefined : finalByte - start + 1;
  const preferred = options.partSizeKb
    ? Math.trunc(options.partSizeKb) * KIB
    : downloadPartSize(rangeSize ?? options.fileSize);
  if (preferred <= 0 || preferred % MIN_PART_BYTES !== 0) {
    throw createMtprotoError('configuration', 'Telegram download parts must align to 4 KiB.');
  }
  const progress = options.progressCallback;
  const requestTimeoutMs = Math.trunc(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  if (requestTimeoutMs <= 0) {
    throw createMtprotoError('configuration', 'Telegram file-part timeout must be positive.');
  }
  progress?.(0);

  if (rangeSize === undefined) {
    const parts: Uint8Array[] = [];
    let offset = start;
    while (true) {
      if (progress?.isCanceled)
        throw createMtprotoError('cancelled', 'Telegram download was cancelled.');
      const limit = Math.min(preferred, ONE_MIB - (offset % ONE_MIB || ONE_MIB));
      const actualLimit = limit === 0 ? preferred : limit;
      const response = await requestPart(
        rpc,
        options.dcId,
        {
          _: 'upload.getFile',
          location,
          offset: BigInt(offset),
          limit: actualLimit,
          ...(offset % MIN_PART_BYTES !== 0 || actualLimit % MIN_PART_BYTES !== 0
            ? { precise: true }
            : {}),
        },
        requestTimeoutMs,
        () => Boolean(progress?.isCanceled),
      );
      const bytes = resultBytes(response);
      if (progress?.isCanceled)
        throw createMtprotoError('cancelled', 'Telegram download was cancelled.');
      parts.push(bytes);
      offset += bytes.length;
      if (bytes.length < actualLimit) break;
    }
    return concatBytes(...parts);
  }

  if (!Number.isSafeInteger(rangeSize) || rangeSize > 2_147_483_647) {
    throw createMtprotoError(
      'configuration',
      'This browser build cannot buffer a Telegram download larger than 2 GiB.',
    );
  }
  const output = new Uint8Array(rangeSize);
  const chunks: Array<{ offset: number; requestLimit: number; outputLength: number }> = [];
  for (let offset = start; offset <= finalByte!;) {
    const remaining = finalByte! - offset + 1;
    const untilMib = ONE_MIB - (offset % ONE_MIB);
    const requestLimit = Math.min(preferred, untilMib);
    const outputLength = Math.min(requestLimit, remaining);
    chunks.push({ offset, requestLimit, outputLength });
    offset += outputLength;
  }
  const workers = Math.max(1, Math.min(Math.trunc(options.workers ?? 1), 8, chunks.length || 1));
  let nextChunk = 0;
  let completedBytes = 0;

  const worker = async () => {
    while (nextChunk < chunks.length) {
      if (progress?.isCanceled)
        throw createMtprotoError('cancelled', 'Telegram download was cancelled.');
      const chunk = chunks[nextChunk]!;
      nextChunk += 1;
      const response = await requestPart(
        rpc,
        options.dcId,
        {
          _: 'upload.getFile',
          location,
          offset: BigInt(chunk.offset),
          limit: chunk.requestLimit,
          ...(chunk.offset % MIN_PART_BYTES !== 0 || chunk.requestLimit % MIN_PART_BYTES !== 0
            ? { precise: true }
            : {}),
        },
        requestTimeoutMs,
        () => Boolean(progress?.isCanceled),
      );
      const bytes = resultBytes(response);
      if (progress?.isCanceled)
        throw createMtprotoError('cancelled', 'Telegram download was cancelled.');
      if (bytes.length < chunk.outputLength) {
        throw createMtprotoError('protocol', 'Telegram returned a truncated file part.');
      }
      output.set(bytes.slice(0, chunk.outputLength), chunk.offset - start);
      completedBytes += Math.min(bytes.length, chunk.outputLength);
      progress?.(Math.min(1, completedBytes / rangeSize));
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));
  return output;
}
