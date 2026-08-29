import { describe, expect, it, vi } from 'vitest';

import { downloadFile } from './download';
import type { TlObject } from '../sender';
import { downloadMedia } from './media';
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
  it('reconstructs stripped photo thumbnails as complete JPEG files', async () => {
    const invoke = vi.fn(async () => ({ _: 'upload.file', bytes: new Uint8Array() }));
    const stripped = new Uint8Array([1, 6, 8, 0xaa, 0xbb]);

    const result = await downloadMedia(
      rpcDouble(invoke),
      {
        _: 'photo',
        id: 1n,
        accessHash: 2n,
        fileReference: new Uint8Array(),
        dcId: 2,
        sizes: [{ _: 'photoStrippedSize', type: 'i', bytes: stripped }],
      },
      { sizeType: 'i' },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(result?.slice(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
    expect(result?.slice(-2)).toEqual(new Uint8Array([0xff, 0xd9]));
    const startOfFrame = result?.findIndex(
      (byte, index) => byte === 0xff && result[index + 1] === 0xc0,
    );
    expect(startOfFrame).toBeGreaterThanOrEqual(0);
    expect(result?.slice(startOfFrame! + 5, startOfFrame! + 9)).toEqual(
      new Uint8Array([0, 6, 0, 8]),
    );
    expect(result?.slice(-4)).toEqual(new Uint8Array([0xaa, 0xbb, 0xff, 0xd9]));
  });

  it('does not treat video markup as a downloadable photo thumbnail', async () => {
    const invoke = vi.fn(async () => ({ _: 'upload.file', bytes: new Uint8Array() }));

    await expect(
      downloadMedia(
        rpcDouble(invoke),
        {
          _: 'photo',
          id: 1n,
          accessHash: 2n,
          fileReference: new Uint8Array(),
          dcId: 2,
          sizes: [],
          videoSizes: [
            {
              _: 'videoSizeEmojiMarkup',
              emojiId: 3n,
              backgroundColors: [0xffffff],
            },
          ],
        },
        { sizeType: 'u' },
      ),
    ).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reconstructs stripped document thumbnails without requesting a file part', async () => {
    const invoke = vi.fn(async () => ({ _: 'upload.file', bytes: new Uint8Array() }));

    const result = await downloadMedia(
      rpcDouble(invoke),
      {
        _: 'document',
        id: 1n,
        accessHash: 2n,
        fileReference: new Uint8Array(),
        dcId: 2,
        size: 4_096n,
        mimeType: 'video/mp4',
        thumbs: [
          {
            _: 'photoStrippedSize',
            type: 'i',
            bytes: new Uint8Array([1, 10, 12, 0x45]),
          },
        ],
      },
      { sizeType: 'i' },
    );

    expect(result?.slice(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
    expect(result?.slice(-3)).toEqual(new Uint8Array([0x45, 0xff, 0xd9]));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not download a whole video when its requested thumbnail is missing', async () => {
    const invoke = vi.fn(async () => ({ _: 'upload.file', bytes: new Uint8Array() }));
    const document = {
      _: 'document',
      id: 1n,
      accessHash: 2n,
      fileReference: new Uint8Array(),
      dcId: 2,
      size: 5_000_000n,
      mimeType: 'video/mp4',
      thumbs: [{ _: 'photoSizeEmpty', type: 'x' }],
    };

    await expect(
      downloadMedia(rpcDouble(invoke), document, { sizeType: 'x' }),
    ).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('falls back to the full non-video document when its requested thumbnail is missing', async () => {
    const requests: TlObject[] = [];
    const rpc = rpcDouble(async (_dcId, request) => {
      requests.push(request);
      return { _: 'upload.file', bytes: new Uint8Array(8).fill(4) };
    });

    const result = await downloadMedia(
      rpc,
      {
        _: 'document',
        id: 1n,
        accessHash: 2n,
        fileReference: new Uint8Array(),
        dcId: 2,
        size: 8n,
        mimeType: 'application/pdf',
        thumbs: [{ _: 'photoSizeEmpty', type: 'x' }],
      },
      { sizeType: 'x' },
    );

    expect(result).toEqual(new Uint8Array(8).fill(4));
    expect(requests[0]).toMatchObject({
      _: 'upload.getFile',
      location: { _: 'inputDocumentFileLocation', thumbSize: '' },
    });
  });

  it('keeps the later photo variant when equally wide sizes are offered', async () => {
    const requests: TlObject[] = [];
    const rpc = rpcDouble(async (_dcId, request) => {
      requests.push(request);
      return { _: 'upload.file', bytes: new Uint8Array(Number(request.limit)).fill(6) };
    });

    await downloadMedia(rpc, {
      _: 'photo',
      id: 1n,
      accessHash: 2n,
      fileReference: new Uint8Array(),
      dcId: 2,
      sizes: [
        { _: 'photoSize', type: 'x', w: 640, h: 640, size: 1_024 },
        { _: 'photoSizeProgressive', type: 'y', w: 640, h: 640, sizes: [2_048] },
      ],
    });

    expect(requests[0]).toMatchObject({
      _: 'upload.getFile',
      location: { _: 'inputPhotoFileLocation', thumbSize: 'y' },
    });
  });

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

  it('rejects an upload canceled while its final part is in flight', async () => {
    let finishPart: ((value: true) => void) | undefined;
    const invoke = vi.fn(
      () =>
        new Promise<true>((resolve) => {
          finishPart = resolve;
        }),
    );
    const progress = Object.assign(vi.fn(), { isCanceled: false });
    const file = new Blob([new Uint8Array([1])]) as Blob & { name: string };
    file.name = 'cancel.bin';
    const uploading = uploadFile(rpcDouble(invoke), { file, workers: 1, onProgress: progress });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());

    progress.isCanceled = true;
    finishPart!(true);

    await expect(uploading).rejects.toMatchObject({ kind: 'cancelled' });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(0);
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

  it('clamps an explicit end offset to the known file size', async () => {
    const requests: TlObject[] = [];
    const result = await downloadFile(
      rpcDouble(async (_dcId, request) => {
        requests.push(request);
        return { _: 'upload.file', bytes: new Uint8Array(8).fill(3) };
      }),
      { _: 'inputDocumentFileLocation' },
      { dcId: 4, fileSize: 8, end: 99 },
    );

    expect(result).toEqual(new Uint8Array(8).fill(3));
    expect(requests).toHaveLength(1);
  });

  it('rejects a download canceled while its final part is in flight', async () => {
    let finishPart: ((value: { _: string; bytes: Uint8Array }) => void) | undefined;
    const invoke = vi.fn(
      () =>
        new Promise<{ _: string; bytes: Uint8Array }>((resolve) => {
          finishPart = resolve;
        }),
    );
    const progress = Object.assign(vi.fn(), { isCanceled: false });
    const downloading = downloadFile(
      rpcDouble(invoke),
      { _: 'inputPhotoFileLocation' },
      { dcId: 3, fileSize: 4, progressCallback: progress },
    );
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());

    progress.isCanceled = true;
    finishPart!({ _: 'upload.file', bytes: new Uint8Array(4) });

    await expect(downloading).rejects.toMatchObject({ kind: 'cancelled' });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(0);
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

  it('shares a three-part backpressure limit per DC without blocking another DC', async () => {
    const pending: Array<{ dcId: number; release: () => void }> = [];
    const active = new Map<number, number>();
    const maximumActive = new Map<number, number>();
    const rpc = rpcDouble(
      (dcId, request) =>
        new Promise((resolve) => {
          active.set(dcId, (active.get(dcId) ?? 0) + 1);
          maximumActive.set(dcId, Math.max(maximumActive.get(dcId) ?? 0, active.get(dcId) ?? 0));
          pending.push({
            dcId,
            release: () => {
              active.set(dcId, (active.get(dcId) ?? 1) - 1);
              resolve({
                _: 'upload.file',
                bytes: new Uint8Array(Number(request.limit)).fill(5),
              });
            },
          });
        }),
    );
    const downloads = Array.from({ length: 4 }, () =>
      downloadFile(rpc, { _: 'inputDocumentFileLocation' }, { dcId: 2, fileSize: 4_096 }),
    );
    downloads.push(
      downloadFile(rpc, { _: 'inputDocumentFileLocation' }, { dcId: 4, fileSize: 4_096 }),
    );

    await vi.waitFor(() => expect(pending).toHaveLength(4));
    expect(pending.filter(({ dcId }) => dcId === 2)).toHaveLength(3);
    expect(pending.filter(({ dcId }) => dcId === 4)).toHaveLength(1);
    expect(maximumActive.get(2)).toBe(3);
    const firstDc2 = pending.findIndex(({ dcId }) => dcId === 2);
    pending.splice(firstDc2, 1)[0]!.release();
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    while (pending.length) pending.shift()!.release();

    await expect(Promise.all(downloads)).resolves.toHaveLength(5);
    expect(maximumActive.get(2)).toBe(3);
    expect(maximumActive.get(4)).toBe(1);
  });

  it('shares the per-DC transfer limit between uploads and downloads', async () => {
    const pending: Array<{ request: TlObject; release: () => void }> = [];
    const rpc = rpcDouble(
      (_dcId, request) =>
        new Promise((resolve) => {
          pending.push({
            request,
            release: () =>
              resolve(
                request._ === 'upload.getFile'
                  ? { _: 'upload.file', bytes: new Uint8Array(Number(request.limit)) }
                  : true,
              ),
          });
        }),
    );
    const file = new Blob([new Uint8Array([1])]) as Blob & { name: string };
    file.name = 'shared.bin';
    const transfers = [
      downloadFile(rpc, { _: 'inputDocumentFileLocation' }, { dcId: 2, fileSize: 4_096 }),
      downloadFile(rpc, { _: 'inputDocumentFileLocation' }, { dcId: 2, fileSize: 4_096 }),
      uploadFile(rpc, { file, workers: 1 }),
      uploadFile(rpc, { file, workers: 1 }),
    ];

    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending.shift()!.release();
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    while (pending.length) pending.shift()!.release();

    await expect(Promise.all(transfers)).resolves.toHaveLength(4);
  });
});
