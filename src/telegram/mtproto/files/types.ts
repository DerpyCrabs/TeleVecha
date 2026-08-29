import type { TlObject } from '../sender';

export type TransferProgress = ((progress: number) => void) & { isCanceled?: boolean | undefined };

export interface FileRpc {
  readonly currentDcId: number;
  randomBytes(length: number): Uint8Array;
  invokeOnDc<Result = unknown>(
    dcId: number,
    request: TlObject,
    options?: { signal?: AbortSignal },
  ): Promise<Result>;
  recoverDc?(dcId: number): Promise<void>;
}

export interface UploadFileOptions {
  file: Blob & { name?: string | undefined };
  workers?: number | undefined;
  onProgress?: TransferProgress | undefined;
}

export interface DownloadFileOptions {
  dcId: number;
  fileSize?: number | undefined;
  workers?: number | undefined;
  partSizeKb?: number | undefined;
  start?: number | undefined;
  end?: number | undefined;
  progressCallback?: TransferProgress | undefined;
  isPriority?: boolean | undefined;
  requestTimeoutMs?: number | undefined;
}

export interface DownloadMediaOptions {
  sizeType?: string | undefined;
  workers?: number | undefined;
  start?: number | undefined;
  end?: number | undefined;
  progressCallback?: TransferProgress | undefined;
}
