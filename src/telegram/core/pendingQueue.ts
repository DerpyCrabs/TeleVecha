import type { CacheStore } from '../persistence/store';
import type { PendingSend } from '../types';

export class PendingSendQueue {
  private readonly nextOrders = new Map<string, number>();

  constructor(private readonly store: CacheStore) {}

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

  clear() {
    this.nextOrders.clear();
  }
}
