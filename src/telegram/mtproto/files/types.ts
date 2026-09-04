import type { Effect } from 'effect';

import type { MtprotoError } from '../errors';
import type { TlObject } from '../sender';

export type TransferProgress = (progress: number) => Effect.Effect<void>;

export interface FileRpc {
  readonly currentDcId: Effect.Effect<number>;
  readonly randomBytes: (length: number) => Effect.Effect<Uint8Array, MtprotoError>;
  readonly invokeOnDc: <Result = unknown>(
    dcId: number,
    request: TlObject,
  ) => Effect.Effect<Result, MtprotoError>;
  readonly recoverDc: (dcId: number) => Effect.Effect<void, MtprotoError>;
}

export interface UploadFileOptions {
  readonly file: Blob & { readonly name?: string | undefined };
  readonly workers?: number | undefined;
  readonly onProgress?: TransferProgress | undefined;
}

export interface DownloadFileOptions {
  readonly dcId: number;
  readonly fileSize?: number | undefined;
  readonly workers?: number | undefined;
  readonly partSizeKb?: number | undefined;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  readonly progress?: TransferProgress | undefined;
  readonly isPriority?: boolean | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

export interface DownloadMediaOptions {
  readonly sizeType?: string | undefined;
  readonly workers?: number | undefined;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  readonly progress?: TransferProgress | undefined;
}
