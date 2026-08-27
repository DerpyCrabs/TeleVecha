import type { CacheStore } from '../persistence/store';
import type { PendingSend } from '../types';

type OutboxStore = Pick<CacheStore, 'commitOutbox'>;

export class PendingSendQueue {
  private readonly nextOrders = new Map<string, number>();
  private readonly activeAttempts = new Set<string>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly peerDeliveryTails = new Map<string, Promise<void>>();
  private readonly peerBlocks = new Map<string, string>();
  private readonly writeTails = new Map<string, Promise<void>>();
  private readonly cancellations = new Set<string>();

  constructor(private readonly store: OutboxStore) {}

  async restore(pending: PendingSend[]) {
    this.nextOrders.clear();
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
        const captured = this.capture(
          send.queueOrder === queueOrder ? send : { ...send, queueOrder },
        );
        restored.push(captured);
        if (send.queueOrder !== queueOrder) migrations.push(captured);
        lastOrder = queueOrder;
      }
      this.nextOrders.set(peerId, lastOrder);
    }
    await Promise.all(migrations.map((send) => this.store.commitOutbox(send)));
    return restored.sort((left, right) => {
      if (left.peer.id === right.peer.id) {
        const queueDifference = (left.queueOrder ?? 0) - (right.queueOrder ?? 0);
        if (queueDifference !== 0) return queueDifference;
      }
      return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
    });
  }

  create(pending: PendingSend) {
    const queueOrder = (this.nextOrders.get(pending.peer.id) ?? 0) + 1;
    this.nextOrders.set(pending.peer.id, queueOrder);
    return this.capture({ ...pending, queueOrder });
  }

  capture(pending: PendingSend): PendingSend {
    const formats = pending.formats?.map((format) => Object.freeze({ ...format }));
    if (formats) Object.freeze(formats);
    const albumAttachments = pending.album?.attachments.map((attachment) =>
      Object.freeze({ ...attachment, sendAs: 'media' as const }),
    );
    if (albumAttachments) Object.freeze(albumAttachments);
    return Object.freeze({
      ...pending,
      peer: Object.freeze({ ...pending.peer }),
      reply: pending.reply ? Object.freeze({ ...pending.reply }) : undefined,
      formats,
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
          })
        : undefined,
      botStart: pending.botStart ? Object.freeze({ ...pending.botStart }) : undefined,
      attachment: pending.attachment
        ? Object.freeze({
            ...pending.attachment,
            sendAs: pending.attachment.sendAs ?? 'media',
          })
        : undefined,
      album: albumAttachments ? Object.freeze({ attachments: albumAttachments }) : undefined,
    });
  }

  blobBytes(pending: PendingSend) {
    if (pending.attachment) return pending.attachment.blob.size;
    return (
      pending.album?.attachments.reduce((total, attachment) => total + attachment.blob.size, 0) ?? 0
    );
  }

  queueWrite<T>(peerId: string, work: () => Promise<T>) {
    const previous = this.writeTails.get(peerId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(work);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.writeTails.set(peerId, tail);
    void tail.then(() => {
      if (this.writeTails.get(peerId) === tail) this.writeTails.delete(peerId);
    });
    return operation;
  }

  pendingWrites() {
    return this.writeTails.values();
  }

  scheduleDelivery(pending: PendingSend, work: () => Promise<void>) {
    const existing = this.deliveries.get(pending.id);
    if (existing) return existing;
    const previous = this.peerDeliveryTails.get(pending.peer.id) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(work);
    let delivery!: Promise<void>;
    delivery = running.finally(() => {
      if (this.deliveries.get(pending.id) === delivery) this.deliveries.delete(pending.id);
      this.cancellations.delete(pending.id);
    });
    const tail = delivery.then(
      () => undefined,
      () => undefined,
    );
    this.deliveries.set(pending.id, delivery);
    this.peerDeliveryTails.set(pending.peer.id, tail);
    void tail.then(() => {
      if (this.peerDeliveryTails.get(pending.peer.id) === tail) {
        this.peerDeliveryTails.delete(pending.peer.id);
      }
    });
    return delivery;
  }

  delivery(id: string) {
    return this.deliveries.get(id);
  }

  cancel(id: string) {
    this.cancellations.add(id);
  }

  finishCancellation(id: string) {
    if (!this.deliveries.has(id)) this.cancellations.delete(id);
  }

  isCancelled(id: string) {
    return this.cancellations.has(id);
  }

  beginAttempt(id: string) {
    if (this.activeAttempts.has(id)) return false;
    this.activeAttempts.add(id);
    return true;
  }

  endAttempt(id: string) {
    this.activeAttempts.delete(id);
  }

  blockedBy(peerId: string) {
    return this.peerBlocks.get(peerId);
  }

  block(peerId: string, pendingId: string) {
    this.peerBlocks.set(peerId, pendingId);
  }

  releaseBlock(peerId: string, pendingId?: string) {
    if (pendingId !== undefined && this.peerBlocks.get(peerId) !== pendingId) return false;
    return this.peerBlocks.delete(peerId);
  }

  clearRuntime() {
    this.activeAttempts.clear();
    this.deliveries.clear();
    this.peerDeliveryTails.clear();
    this.peerBlocks.clear();
    this.writeTails.clear();
    this.cancellations.clear();
  }

  clear() {
    this.nextOrders.clear();
    this.clearRuntime();
  }
}
