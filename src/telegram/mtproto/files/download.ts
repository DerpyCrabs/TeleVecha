import { Effect, Ref, Stream } from 'effect';

import { concatBytes } from '../bytes';
import { createMtprotoError, type MtprotoError } from '../errors';
import type { TlObject } from '../sender';
import type { DownloadFileOptions, FileRpc } from './types';

const KIB = 1_024;
const MIN_PART_BYTES = 4 * KIB;
const ONE_MIB = 1_024 * 1_024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function downloadPartSize(fileSize: number | undefined): Effect.Effect<number, MtprotoError> {
  if (fileSize === undefined || fileSize <= 64 * KIB) return Effect.succeed(64 * KIB);
  if (fileSize <= 100 * ONE_MIB) return Effect.succeed(128 * KIB);
  if (fileSize <= 750 * ONE_MIB) return Effect.succeed(256 * KIB);
  if (fileSize <= 2_000 * ONE_MIB) return Effect.succeed(512 * KIB);
  if (fileSize <= 4_000 * ONE_MIB) return Effect.succeed(ONE_MIB);
  return Effect.fail(
    createMtprotoError('configuration', 'Telegram downloads cannot exceed 4,000 MiB.'),
  );
}

const resultBytes = Effect.fn('mtproto.files.resultBytes')(function* (result: unknown) {
  if (!result || typeof result !== 'object') {
    return yield* Effect.fail(createMtprotoError('protocol', 'Telegram returned no file bytes.'));
  }
  const record = result as TlObject;
  if (record._ === 'upload.fileCdnRedirect') {
    return yield* Effect.fail(
      createMtprotoError('configuration', 'Telegram CDN redirects are not supported.'),
    );
  }
  if (record._ !== 'upload.file' || !(record.bytes instanceof Uint8Array)) {
    return yield* Effect.fail(
      createMtprotoError('protocol', 'Telegram returned an unexpected file response.'),
    );
  }
  return record.bytes;
});

const requestPart = Effect.fn('mtproto.files.requestPart')(function* (
  rpc: FileRpc,
  dcId: number,
  request: TlObject,
  requestTimeoutMs: number,
) {
  const attempt = rpc.invokeOnDc<unknown>(dcId, request).pipe(
    Effect.timeoutOrElse({
      duration: requestTimeoutMs,
      orElse: () =>
        Effect.fail(createMtprotoError('transport', 'Telegram file-part request timed out.')),
    }),
  );
  return yield* attempt.pipe(
    Effect.catch((error) =>
      error.kind === 'transport'
        ? rpc.recoverDc(dcId).pipe(Effect.andThen(attempt))
        : Effect.fail(error),
    ),
  );
});

export const downloadFile = Effect.fn('mtproto.files.download')(function* (
  rpc: FileRpc,
  location: TlObject,
  options: DownloadFileOptions,
) {
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
  const preferred =
    options.partSizeKb === undefined
      ? yield* downloadPartSize(rangeSize ?? options.fileSize)
      : Math.trunc(options.partSizeKb) * KIB;
  if (preferred <= 0 || preferred % MIN_PART_BYTES !== 0) {
    return yield* Effect.fail(
      createMtprotoError('configuration', 'Telegram download parts must align to 4 KiB.'),
    );
  }
  const requestTimeoutMs = Math.trunc(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  if (requestTimeoutMs <= 0) {
    return yield* Effect.fail(
      createMtprotoError('configuration', 'Telegram file-part timeout must be positive.'),
    );
  }
  if (options.progress) yield* options.progress(0);

  if (rangeSize === undefined) {
    const parts = yield* Stream.unfold({ offset: start, done: false }, (state) => {
      if (state.done) return Effect.succeed(undefined);
      const offset = state.offset;
      const untilMib = ONE_MIB - (offset % ONE_MIB);
      const limit = Math.min(preferred, untilMib);
      return requestPart(
        rpc,
        options.dcId,
        {
          _: 'upload.getFile',
          location,
          offset: BigInt(offset),
          limit,
          ...(offset % MIN_PART_BYTES !== 0 || limit % MIN_PART_BYTES !== 0
            ? { precise: true }
            : {}),
        },
        requestTimeoutMs,
      ).pipe(
        Effect.flatMap(resultBytes),
        Effect.map((bytes) =>
          bytes.length === 0
            ? undefined
            : ([bytes, { offset: offset + bytes.length, done: bytes.length < limit }] as const),
        ),
      );
    }).pipe(Stream.runCollect);
    return concatBytes(...parts);
  }

  if (!Number.isSafeInteger(rangeSize) || rangeSize > 2_147_483_647) {
    return yield* Effect.fail(
      createMtprotoError(
        'configuration',
        'This browser build cannot buffer a Telegram download larger than 2 GiB.',
      ),
    );
  }
  const chunks: Array<{ offset: number; requestLimit: number; outputLength: number }> = [];
  for (let offset = start; offset <= finalByte!;) {
    const remaining = finalByte! - offset + 1;
    const requestLimit = Math.min(preferred, ONE_MIB - (offset % ONE_MIB));
    const outputLength = Math.min(requestLimit, remaining);
    chunks.push({ offset, requestLimit, outputLength });
    offset += outputLength;
  }
  const output = new Uint8Array(rangeSize);
  const completed = yield* Ref.make(0);
  const workers = Math.max(1, Math.min(Math.trunc(options.workers ?? 1), 3, chunks.length || 1));
  yield* Effect.forEach(
    chunks,
    (chunk) =>
      requestPart(
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
      ).pipe(
        Effect.flatMap(resultBytes),
        Effect.flatMap((bytes) => {
          if (bytes.length < chunk.outputLength) {
            return Effect.fail(
              createMtprotoError('protocol', 'Telegram returned a truncated file part.'),
            );
          }
          return Effect.sync(() =>
            output.set(bytes.subarray(0, chunk.outputLength), chunk.offset - start),
          ).pipe(
            Effect.andThen(Ref.updateAndGet(completed, (value) => value + chunk.outputLength)),
            Effect.flatMap((value) =>
              options.progress ? options.progress(Math.min(1, value / rangeSize)) : Effect.void,
            ),
          );
        }),
      ),
    { concurrency: workers, discard: true },
  );
  return output;
});
