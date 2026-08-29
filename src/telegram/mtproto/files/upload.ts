import { bytesToBigInt } from '../bytes';
import { createMtprotoError } from '../errors';
import type { TlObject } from '../sender';
import type { FileRpc, UploadFileOptions } from './types';

const KIB = 1_024;
const LARGE_FILE_BYTES = 10 * 1_024 * 1_024;

function uploadPartSize(fileSize: number) {
  if (fileSize <= 100 * 1_024 * 1_024) return 128 * KIB;
  if (fileSize <= 750 * 1_024 * 1_024) return 256 * KIB;
  if (fileSize <= 4_000 * 1_024 * 1_024) return 512 * KIB;
  throw createMtprotoError('configuration', 'Telegram uploads cannot exceed 4,000 MiB.');
}

export async function uploadFile(rpc: FileRpc, options: UploadFileOptions): Promise<TlObject> {
  const file = options.file;
  const name = file.name?.trim() || 'upload.bin';
  const partSize = uploadPartSize(file.size);
  const partCount = Math.max(1, Math.ceil(file.size / partSize));
  const fileId = bytesToBigInt(rpc.randomBytes(8), { littleEndian: true, signed: true });
  const large = file.size > LARGE_FILE_BYTES;
  const workerCount = Math.max(1, Math.min(Math.trunc(options.workers ?? 2), 8, partCount || 1));
  let nextPart = 0;
  let completed = 0;
  options.onProgress?.(0);

  const worker = async () => {
    while (nextPart < partCount) {
      if (options.onProgress?.isCanceled) {
        throw createMtprotoError('cancelled', 'Telegram upload was cancelled.');
      }
      const part = nextPart;
      nextPart += 1;
      const bytes = new Uint8Array(
        await file.slice(part * partSize, Math.min((part + 1) * partSize, file.size)).arrayBuffer(),
      );
      const request: TlObject = large
        ? {
            _: 'upload.saveBigFilePart',
            fileId,
            filePart: part,
            fileTotalParts: partCount,
            bytes,
          }
        : { _: 'upload.saveFilePart', fileId, filePart: part, bytes };
      const accepted = await rpc.invokeOnDc<unknown>(rpc.currentDcId, request);
      if (accepted !== true && (accepted as TlObject | undefined)?._ !== 'boolTrue') {
        throw createMtprotoError('rpc', `Telegram rejected upload part ${part}.`);
      }
      completed += 1;
      options.onProgress?.(completed / partCount);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return large
    ? { _: 'inputFileBig', id: fileId, parts: partCount, name }
    : { _: 'inputFile', id: fileId, parts: partCount, name, md5Checksum: '' };
}
