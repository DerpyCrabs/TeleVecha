import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { downloadFile } from './download';
import { downloadMedia } from './media';
import type { FileRpc } from './types';
import { uploadFile } from './upload';
import { createMtprotoError } from '../errors';
import type { TlObject } from '../sender';

const rpcDouble = (
  invoke: (
    dcId: number,
    request: TlObject,
  ) => Effect.Effect<unknown, ReturnType<typeof createMtprotoError>>,
): FileRpc => ({
  currentDcId: Effect.succeed(2),
  randomBytes: (length) => Effect.succeed(new Uint8Array(length).fill(7)),
  invokeOnDc: ((dcId: number, request: TlObject) => invoke(dcId, request)) as FileRpc['invokeOnDc'],
  recoverDc: () => Effect.void,
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe('Telegram file transfers', () => {
  it('reconstructs stripped photo thumbnails without an RPC', () =>
    run(
      Effect.gen(function* () {
        const invoke = vi.fn(() => Effect.succeed({ _: 'upload.file', bytes: new Uint8Array() }));
        const result = yield* downloadMedia(
          rpcDouble(invoke),
          {
            _: 'photo',
            id: 1n,
            accessHash: 2n,
            fileReference: new Uint8Array(),
            dcId: 2,
            sizes: [
              { _: 'photoStrippedSize', type: 'i', bytes: new Uint8Array([1, 6, 8, 0xaa, 0xbb]) },
            ],
          },
          { sizeType: 'i' },
        );
        expect(invoke).not.toHaveBeenCalled();
        expect(result?.slice(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
        expect(result?.slice(-2)).toEqual(new Uint8Array([0xff, 0xd9]));
      }),
    ));

  it('uploads file parts concurrently and reports progress as Effects', () =>
    run(
      Effect.gen(function* () {
        const requests: TlObject[] = [];
        const progress: number[] = [];
        const rpc = rpcDouble((_dcId, request) =>
          Effect.sync(() => {
            requests.push(request);
            return true;
          }),
        );
        const file = new Blob([new Uint8Array(300 * 1_024)]) as Blob & { name: string };
        file.name = 'sample.bin';
        const uploaded = yield* uploadFile(rpc, {
          file,
          workers: 3,
          onProgress: (value) =>
            Effect.sync(() => {
              progress.push(value);
            }),
        });
        expect(uploaded).toMatchObject({ _: 'inputFile', name: 'sample.bin', parts: 3 });
        expect(
          requests
            .map((request) => request.filePart)
            .sort((left, right) => Number(left) - Number(right)),
        ).toEqual([0, 1, 2]);
        expect(progress[0]).toBe(0);
        expect(progress.at(-1)).toBe(1);
      }),
    ));

  it('requests aligned parts and trims the known final range', () =>
    run(
      Effect.gen(function* () {
        const requests: TlObject[] = [];
        const rpc = rpcDouble((_dcId, request) =>
          Effect.sync(() => {
            requests.push(request);
            return { _: 'upload.file', bytes: new Uint8Array(128 * 1_024).fill(9) };
          }),
        );
        const result = yield* downloadFile(
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
      }),
    ));

  it('interrupts in-flight transfers through the Effect scope', () =>
    run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let interrupted = false;
        const rpc = rpcDouble(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
        );
        const downloading = yield* downloadFile(
          rpc,
          { _: 'inputDocumentFileLocation' },
          { dcId: 2, fileSize: 4_096 },
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(downloading);
        expect(interrupted).toBe(true);
      }),
    ));
});
