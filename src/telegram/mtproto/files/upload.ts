import { Effect, Ref } from 'effect';

import { bytesToBigInt } from '../bytes';
import { createMtprotoError } from '../errors';
import type { TlObject } from '../sender';
import type { FileRpc, UploadFileOptions } from './types';

const KIB = 1_024;
const LARGE_FILE_BYTES = 10 * 1_024 * 1_024;

const uploadPartSize = Effect.fn('mtproto.files.uploadPartSize')(function* (fileSize: number) {
  if (fileSize <= 100 * 1_024 * 1_024) return 128 * KIB;
  if (fileSize <= 750 * 1_024 * 1_024) return 256 * KIB;
  if (fileSize <= 4_000 * 1_024 * 1_024) return 512 * KIB;
  return yield* Effect.fail(
    createMtprotoError('configuration', 'Telegram uploads cannot exceed 4,000 MiB.'),
  );
});

export const uploadFile = Effect.fn('mtproto.files.upload')(function* (
  rpc: FileRpc,
  options: UploadFileOptions,
) {
  const file = options.file;
  const name = file.name?.trim() || 'upload.bin';
  const partSize = yield* uploadPartSize(file.size);
  const partCount = Math.max(1, Math.ceil(file.size / partSize));
  const fileId = bytesToBigInt(yield* rpc.randomBytes(8), {
    littleEndian: true,
    signed: true,
  });
  const large = file.size > LARGE_FILE_BYTES;
  const completed = yield* Ref.make(0);
  const workerCount = Math.max(1, Math.min(Math.trunc(options.workers ?? 2), 3, partCount));
  if (options.onProgress) yield* options.onProgress(0);

  yield* Effect.forEach(
    Array.from({ length: partCount }, (_, part) => part),
    (part) =>
      Effect.gen(function* () {
        const bytes = yield* Effect.tryPromise({
          try: () =>
            file.slice(part * partSize, Math.min((part + 1) * partSize, file.size)).arrayBuffer(),
          catch: (cause) =>
            createMtprotoError('transport', 'Could not read a Telegram upload part.', { cause }),
        }).pipe(Effect.map((buffer) => new Uint8Array(buffer)));
        const request: TlObject = large
          ? {
              _: 'upload.saveBigFilePart',
              fileId,
              filePart: part,
              fileTotalParts: partCount,
              bytes,
            }
          : { _: 'upload.saveFilePart', fileId, filePart: part, bytes };
        const dcId = yield* rpc.currentDcId;
        const accepted = yield* rpc.invokeOnDc<unknown>(dcId, request);
        if (accepted !== true && (accepted as TlObject | undefined)?._ !== 'boolTrue') {
          return yield* Effect.fail(
            createMtprotoError('rpc', `Telegram rejected upload part ${part}.`),
          );
        }
        const count = yield* Ref.updateAndGet(completed, (value) => value + 1);
        if (options.onProgress) yield* options.onProgress(count / partCount);
      }),
    { concurrency: workerCount, discard: true },
  );
  return large
    ? { _: 'inputFileBig', id: fileId, parts: partCount, name }
    : { _: 'inputFile', id: fileId, parts: partCount, name, md5Checksum: '' };
});
