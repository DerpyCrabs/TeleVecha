import { Cause, Effect, Fiber, FiberMap, Option } from 'effect';

import type { CacheStore } from '../persistence/store';
import type { PendingSend } from '../types';
import type { EngineTasks } from './engineTasks';

type OutboxStore = Pick<CacheStore, 'commitOutbox'>;

export const makePendingSendQueue = Effect.fn('PendingSendQueue.make')(function* (
  store: OutboxStore,
  tasks: EngineTasks,
) {
  const nextOrders = new Map<string, number>();
  const activeAttempts = new Set<string>();
  const peerBlocks = new Map<string, string>();
  const cancellations = new Set<string>();
  const deliveries = yield* FiberMap.make<string, void, unknown>();

  const capture = (pending: PendingSend): PendingSend => {
    const formats = pending.formats?.map((format) => Object.freeze({ ...format }));
    if (formats) Object.freeze(formats);
    const albumAttachments = pending.album?.attachments.map((attachment) =>
      Object.freeze({ ...attachment }),
    );
    if (albumAttachments) Object.freeze(albumAttachments);
    return Object.freeze({
      ...pending,
      peer: Object.freeze({ ...pending.peer }),
      reply: pending.reply ? Object.freeze({ ...pending.reply }) : undefined,
      formats,
      pollDraft: pending.pollDraft
        ? Object.freeze({
            ...pending.pollDraft,
            answers: Object.freeze([...pending.pollDraft.answers]),
          })
        : undefined,
      contact: pending.contact
        ? Object.freeze({
            ...pending.contact,
            peer: pending.contact.peer ? Object.freeze({ ...pending.contact.peer }) : undefined,
          })
        : undefined,
      sticker: pending.sticker
        ? Object.freeze({
            ...pending.sticker,
            fileReference: new Uint8Array(pending.sticker.fileReference),
          })
        : undefined,
      forward: pending.forward
        ? Object.freeze({
            fromPeer: Object.freeze({ ...pending.forward.fromPeer }),
            messageId: pending.forward.messageId,
            ...(pending.forward.options
              ? { options: Object.freeze({ ...pending.forward.options }) }
              : {}),
            ...(pending.forward.mediaKind === undefined
              ? {}
              : { mediaKind: pending.forward.mediaKind }),
          })
        : undefined,
      botStart: pending.botStart ? Object.freeze({ ...pending.botStart }) : undefined,
      attachment: pending.attachment
        ? Object.freeze({ ...pending.attachment, sendAs: pending.attachment.sendAs ?? 'media' })
        : undefined,
      album: albumAttachments ? Object.freeze({ attachments: albumAttachments }) : undefined,
    });
  };

  const restore = Effect.fn('PendingSendQueue.restore')(function* (pending: PendingSend[]) {
    nextOrders.clear();
    const byPeer = new Map<string, PendingSend[]>();
    for (const send of pending) {
      const sends = byPeer.get(send.peer.id) ?? [];
      sends.push(send);
      byPeer.set(send.peer.id, sends);
    }
    const restored: PendingSend[] = [];
    const migrations: PendingSend[] = [];
    for (const [peerId, sends] of byPeer) {
      sends.sort((left, right) => {
        if (
          left.queueOrder !== undefined &&
          right.queueOrder !== undefined &&
          left.queueOrder !== right.queueOrder
        ) {
          return left.queueOrder - right.queueOrder;
        }
        return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
      });
      let lastOrder = 0;
      for (const send of sends) {
        const queueOrder =
          send.queueOrder !== undefined && send.queueOrder > lastOrder
            ? send.queueOrder
            : lastOrder + 1;
        const captured = capture(send.queueOrder === queueOrder ? send : { ...send, queueOrder });
        restored.push(captured);
        if (send.queueOrder !== queueOrder) migrations.push(captured);
        lastOrder = queueOrder;
      }
      nextOrders.set(peerId, lastOrder);
    }
    yield* Effect.forEach(migrations, (send) => store.commitOutbox(send), {
      concurrency: 'unbounded',
      discard: true,
    });
    return restored.sort((left, right) => {
      if (left.peer.id === right.peer.id) {
        const queueDifference = (left.queueOrder ?? 0) - (right.queueOrder ?? 0);
        if (queueDifference !== 0) return queueDifference;
      }
      return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
    });
  });

  const create = (pending: PendingSend) => {
    const queueOrder = (nextOrders.get(pending.peer.id) ?? 0) + 1;
    nextOrders.set(pending.peer.id, queueOrder);
    return capture({ ...pending, queueOrder });
  };

  const blobBytes = (pending: PendingSend) =>
    pending.attachment
      ? pending.attachment.blob.size
      : (pending.album?.attachments.reduce(
          (total, attachment) => total + attachment.blob.size,
          0,
        ) ?? 0);

  const queueWrite = <Value, Error, Requirements>(
    peerId: string,
    work: Effect.Effect<Value, Error, Requirements>,
  ) => tasks.serialize('outboxWrite', peerId, work);

  const awaitDelivery = (id: string, fiber: Fiber.Fiber<void, unknown>) =>
    Fiber.join(fiber).pipe(
      Effect.catchCause((cause) =>
        cancellations.has(id) && Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.failCause(cause),
      ),
    );

  const scheduleDelivery = <Error, Requirements>(
    pending: PendingSend,
    work: Effect.Effect<void, Error, Requirements>,
  ) =>
    Effect.gen(function* () {
      const current = yield* FiberMap.get(deliveries, pending.id);
      if (Option.isSome(current)) return yield* awaitDelivery(pending.id, current.value);
      const fiber = yield* FiberMap.run(
        deliveries,
        pending.id,
        tasks.serialize('outboxDelivery', pending.peer.id, work),
      );
      return yield* awaitDelivery(pending.id, fiber);
    });

  const delivery = (id: string) =>
    FiberMap.get(deliveries, id).pipe(
      Effect.map((current) =>
        Option.isSome(current) ? awaitDelivery(id, current.value) : undefined,
      ),
    );

  const clearRuntime = Effect.all(
    [
      FiberMap.clear(deliveries),
      Effect.sync(() => {
        activeAttempts.clear();
        peerBlocks.clear();
        cancellations.clear();
      }),
    ],
    { discard: true },
  );

  return {
    restore,
    create,
    capture,
    blobBytes,
    queueWrite,
    scheduleDelivery,
    delivery,
    cancel: (id: string) =>
      Effect.gen(function* () {
        cancellations.add(id);
        yield* FiberMap.remove(deliveries, id);
      }),
    finishCancellation: (id: string) =>
      FiberMap.has(deliveries, id).pipe(
        Effect.flatMap((active) =>
          active ? Effect.void : Effect.sync(() => cancellations.delete(id)).pipe(Effect.asVoid),
        ),
      ),
    isCancelled: (id: string) => cancellations.has(id),
    beginAttempt: (id: string) => {
      if (activeAttempts.has(id)) return false;
      activeAttempts.add(id);
      return true;
    },
    endAttempt: (id: string) => activeAttempts.delete(id),
    blockedBy: (peerId: string) => peerBlocks.get(peerId),
    block: (peerId: string, pendingId: string) => peerBlocks.set(peerId, pendingId),
    releaseBlock: (peerId: string, pendingId?: string) => {
      if (pendingId !== undefined && peerBlocks.get(peerId) !== pendingId) return false;
      return peerBlocks.delete(peerId);
    },
    clearRuntime,
    clear: Effect.andThen(
      Effect.sync(() => nextOrders.clear()),
      clearRuntime,
    ),
  };
});

export type PendingSendQueue = Effect.Success<ReturnType<typeof makePendingSendQueue>>;
