import type { PendingSend, TelegramMessage } from './types';
import { canReuseUploadedMedia } from './localMedia';

/** Correlates confirmed media with its local upload, including individual album items. */
export function pendingMediaForMessage(pending: readonly PendingSend[], message: TelegramMessage) {
  if (!message.outgoing || !message.randomId || message.editedAt || !message.media)
    return undefined;
  for (const send of pending) {
    if (send.peer.id !== message.peerId) continue;
    if (send.album) {
      const index = send.album.attachments.findIndex(
        ({ randomId }) => randomId === message.randomId,
      );
      const attachment = send.album.attachments[index];
      if (attachment && canReuseUploadedMedia(message.media, attachment.blob)) {
        return { messageId: `${send.id}:${index}`, attachment };
      }
    } else if (
      send.randomId === message.randomId &&
      send.attachment &&
      canReuseUploadedMedia(message.media, send.attachment.blob)
    ) {
      return { messageId: send.id, attachment: send.attachment };
    }
  }
  return undefined;
}
