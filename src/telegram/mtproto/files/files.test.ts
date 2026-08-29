import { describe, expect, it, vi } from 'vitest';

import { downloadFile } from './download';
import type { TlObject } from '../sender';
import type { FileRpc } from './types';
import { uploadFile } from './upload';

function rpcDouble(
  invoke: (dcId: number, request: TlObject, options?: { signal?: AbortSignal }) => Promise<unknown>,
  recoverDc?: (dcId: number) => Promise<void>,
): FileRpc {
  return {
    currentDcId: 2,
    randomBytes: (length) => new Uint8Array(length).fill(7),
    async invokeOnDc<Result>(dcId: number, request: TlObject, options?: { signal?: AbortSignal }) {
      return (await invoke(dcId, request, options)) as Result;
    },
    ...(recoverDc ? { recoverDc } : {}),
  };
}

describe('Telegram file transfers', () => {
  it('uploads small files concurrently and reports deterministic progress', async () => {
    const requests: TlObject[] = [];
    const progress = vi.fn();
    const rpc = rpcDouble(async (_dcId, request) => {
      requests.push(request);
      return true;
    });
    const bytes = new Uint8Array(300 * 1_024).map((_, index) => index & 0xff);
    const file = new Blob([bytes], { type: 'application/octet-stream' }) as Blob & {
      name: string;
    };
    file.name = 'sample.bin';

    const uploaded = await uploadFile(rpc, { file, workers: 3, onProgress: progress });

    expect(uploaded).toMatchObject({ _: 'inputFile', name: 'sample.bin', parts: 3 });
    expect(
      requests
        .map((request) => request.filePart)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([0, 1, 2]);
    expect(requests.every((request) => request._ === 'upload.saveFilePart')).toBe(true);
    expect(progress).toHaveBeenCalledWith(0);
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it('persists one part for an empty upload', async () => {
    const requests: TlObject[] = [];
    const invoke = vi.fn(async (_dcId: number, request: TlObject) => {
      requests.push(request);
      return true;
    });
    const file = new Blob([]) as Blob & { name: string };
    file.name = 'empty.txt';
    const uploaded = await uploadFile(rpcDouble(invoke), { file });

    expect(uploaded).toMatchObject({ _: 'inputFile', parts: 1, name: 'empty.txt' });
    expect(invoke).toHaveBeenCalledOnce();
    expect(requests[0]?.bytes).toEqual(new Uint8Array(0));
  });

  it('requests aligned full parts and trims the known final range', async () => {
    const requests: TlObject[] = [];
    const rpc = rpcDouble(async (_dcId, request) => {
      requests.push(request);
      return { _: 'upload.file', bytes: new Uint8Array(128 * 1_024).fill(9) };
    });

    const result = await downloadFile(
      rpc,
      { _: 'inputDocumentFileLocation' },
      {
        dcId: 4,
        fileSize: 70 * 1_024,
      },
    );

    expect(result).toHaveLength(70 * 1_024);
    expect(result[0]).toBe(9);
    expect(requests).toEqual([
      {
        _: 'upload.getFile',
        location: { _: 'inputDocumentFileLocation' },
        offset: 0n,
        limit: 128 * 1_024,
      },
    ]);
  });

  it('downloads unknown lengths sequentially and rejects CDN redirects', async () => {
    let call = 0;
    const rpc = rpcDouble(async () => {
      call += 1;
      return { _: 'upload.file', bytes: new Uint8Array(call === 1 ? 64 * 1_024 : 3).fill(call) };
    });
    const result = await downloadFile(rpc, { _: 'inputPhotoFileLocation' }, { dcId: 3 });
    expect(result).toHaveLength(64 * 1_024 + 3);
    expect(result.at(-1)).toBe(2);

    await expect(
      downloadFile(
        rpcDouble(async () => ({ _: 'upload.fileCdnRedirect' })),
        { _: 'inputPhotoFileLocation' },
        { dcId: 3 },
      ),
    ).rejects.toThrow('CDN redirects are not supported');
  });

  it('aborts a lost part, recovers its DC, and retries once', async () => {
    vi.useFakeTimers();
    const recoverDc = vi.fn(async () => undefined);
    let attempt = 0;
    const rpc = rpcDouble(async (_dcId, _request, options) => {
      attempt += 1;
      if (attempt > 1) return { _: 'upload.file', bytes: new Uint8Array(64 * 1_024) };
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    }, recoverDc);
    const downloading = downloadFile(
      rpc,
      { _: 'inputPhotoFileLocation' },
      { dcId: 4, fileSize: 64 * 1_024, requestTimeoutMs: 25 },
    );
    await vi.advanceTimersByTimeAsync(25);

    await expect(downloading).resolves.toHaveLength(64 * 1_024);
    expect(recoverDc).toHaveBeenCalledWith(4);
    vi.useRealTimers();
  });
});
