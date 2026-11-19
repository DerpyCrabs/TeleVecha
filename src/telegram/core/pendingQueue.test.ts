import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import type { PendingSend } from '../types';
import { EngineTasks, EngineTasksLayer } from './engineTasks';
import { makePendingSendQueue } from './pendingQueue';

function pending(id: string, peerId: string = 'u:1') {
  return { id, peer: { id: peerId, kind: 'user' }, createdAt: 1 } as PendingSend;
}

const withQueue = <A, E>(
  use: (
    queue: Effect.Success<ReturnType<typeof makePendingSendQueue>>,
  ) => Effect.Effect<A, E, never>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const tasks = yield* EngineTasks;
      const queue = yield* makePendingSendQueue({ commitOutbox: vi.fn(() => Effect.void) }, tasks);
      return yield* use(queue);
    }).pipe(Effect.provide(EngineTasksLayer)),
  );

describe('PendingSendQueue coordination', () => {
  it('serializes one peer while allowing another peer to proceed', () =>
    Effect.runPromise(
      withQueue((queue) =>
        Effect.gen(function* () {
          const events: string[] = [];
          const firstGate = yield* Deferred.make<void>();
          const first = yield* queue
            .scheduleDelivery(
              pending('first'),
              Effect.gen(function* () {
                events.push('first:start');
                yield* Deferred.await(firstGate);
                events.push('first:end');
              }),
            )
            .pipe(Effect.forkChild);
          const second = yield* queue
            .scheduleDelivery(
              pending('second'),
              Effect.sync(() => {
                events.push('second');
              }),
            )
            .pipe(Effect.forkChild);
          const otherPeer = yield* queue
            .scheduleDelivery(
              pending('other', 'u:2'),
              Effect.sync(() => {
                events.push('other');
              }),
            )
            .pipe(Effect.forkChild);
          yield* Fiber.join(otherPeer);
          expect(events).toEqual(['first:start', 'other']);
          yield* Deferred.succeed(firstGate, undefined);
          yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
          expect(events).toEqual(['first:start', 'other', 'first:end', 'second']);
        }),
      ),
    ));

  it('releases a delivery lane when earlier work fails', () =>
    Effect.runPromise(
      withQueue((queue) =>
        Effect.gen(function* () {
          const error = new Error('failed delivery');
          const secondWork = vi.fn<() => void>();
          const first = yield* queue
            .scheduleDelivery(pending('first'), Effect.fail(error))
            .pipe(Effect.result, Effect.forkChild);
          const second = yield* queue
            .scheduleDelivery(pending('second'), Effect.sync(secondWork))
            .pipe(Effect.forkChild);
          expect((yield* Fiber.join(first))._tag).toBe('Failure');
          yield* Fiber.join(second);
          expect(secondWork).toHaveBeenCalledOnce();
        }),
      ),
    ));

  it('serializes writes', () =>
    Effect.runPromise(
      withQueue((queue) =>
        Effect.gen(function* () {
          const events: string[] = [];
          const firstGate = yield* Deferred.make<void>();
          const first = yield* queue
            .queueWrite(
              'u:1',
              Effect.gen(function* () {
                events.push('first:start');
                yield* Deferred.await(firstGate);
                events.push('first:end');
              }),
            )
            .pipe(Effect.forkChild);
          const second = yield* queue
            .queueWrite(
              'u:1',
              Effect.sync(() => {
                events.push('second');
              }),
            )
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(events).toEqual(['first:start']);
          yield* Deferred.succeed(firstGate, undefined);
          yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
          expect(events).toEqual(['first:start', 'first:end', 'second']);
        }),
      ),
    ));

  it('completes cancellation waiters normally and releases the peer delivery lane', () =>
    Effect.runPromise(
      withQueue((queue) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const stopped = vi.fn();
          const first = yield* queue
            .scheduleDelivery(
              pending('first'),
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Effect.sync(stopped)),
              ),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Effect.yieldNow;
          const wait = yield* queue.delivery('first');
          expect(wait).toBeDefined();
          const waiter = yield* wait!.pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* queue.cancel('first');
          yield* Fiber.join(first);
          yield* Fiber.join(waiter);
          expect(stopped).toHaveBeenCalledOnce();
          const next = vi.fn<() => void>();
          yield* queue.scheduleDelivery(pending('next'), Effect.sync(next));
          expect(next).toHaveBeenCalledOnce();
          yield* queue.finishCancellation('first');
          expect(queue.isCancelled('first')).toBe(false);
        }),
      ),
    ));

  it('owns cancellation and peer blocking state', () =>
    Effect.runPromise(
      withQueue((queue) =>
        Effect.gen(function* () {
          yield* queue.cancel('send');
          queue.block('u:1', 'send');
          expect(queue.isCancelled('send')).toBe(true);
          expect(queue.blockedBy('u:1')).toBe('send');
          expect(queue.releaseBlock('u:1', 'different')).toBe(false);
          expect(queue.releaseBlock('u:1', 'send')).toBe(true);
          yield* queue.finishCancellation('send');
          expect(queue.isCancelled('send')).toBe(false);
        }),
      ),
    ));
});

it('reserves storage for both upload data and preview blobs', () =>
  Effect.runPromise(
    withQueue((queue) =>
      Effect.sync(() => {
        const attachment = {
          blob: new Blob(['original']),
          preview: new Blob(['preview']),
          name: 'video',
          mimeType: 'video/mp4',
          asSticker: false,
          sendAs: 'media' as const,
        };
        expect(queue.blobBytes({ ...pending('video'), attachment })).toBe(15);
        expect(
          queue.blobBytes({
            ...pending('album'),
            album: { attachments: [{ ...attachment, randomId: '1' }] },
          }),
        ).toBe(15);
      }),
    ),
  ));

it('preserves assigned FIFO order when legacy sends have intermediate timestamps', () =>
  Effect.runPromise(
    withQueue((queue) =>
      Effect.gen(function* () {
        const restored = yield* queue.restore([
          { ...pending('second'), queueOrder: 2, createdAt: 1 },
          { ...pending('legacy'), createdAt: 2 },
          { ...pending('first'), queueOrder: 1, createdAt: 3 },
        ]);
        expect(restored.findIndex((s) => s.id === 'first')).toBeLessThan(
          restored.findIndex((s) => s.id === 'second'),
        );
      }),
    ),
  ));
