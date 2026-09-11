import type { Snapshot } from 'effectweb';
import type { ChatMessage } from '../../domain/models';
import type { EngineSnapshot, PendingAttachment, PendingSend } from '../../telegram/types';
import { presentMessage, presentPendingAttachment, presentReply } from './presentation';

export interface KeyedMessageView {
  key: string;
  message: ChatMessage;
}

function pendingMessage(
  send: PendingSend,
  messagesById: Map<number, EngineSnapshot['messages'][number]>,
  id: string,
  randomId: string,
  attachment?: PendingAttachment,
  index: number = 0,
): KeyedMessageView {
  const first = index === 0;
  const media = send.sticker
    ? {
        kind: 'sticker' as const,
        name: `sticker-${send.sticker.id}`,
        mimeType: send.sticker.mimeType,
      }
    : attachment
      ? presentPendingAttachment(attachment)
      : undefined;
  const value: ChatMessage = {
    id,
    peerId: send.peer.id,
    author: 'You',
    senderId: 'self',
    body: first ? send.text : '',
    time: new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
      new Date(send.createdAt),
    ),
    date: Math.floor(send.createdAt / 1000),
    outgoing: true,
    status: send.lastError ? 'failed' : 'sending',
    ...(attachment
      ? {
          // Album uploads advance sequentially in equal per-attachment slots.
          uploadProgress: Math.max(
            0,
            Math.min(1, (send.uploadProgress ?? 0) * (send.album?.attachments.length ?? 1) - index),
          ),
        }
      : {}),
    ...(first
      ? {
          formats: send.formats?.filter(({ kind }) => kind !== 'textUrl'),
          links: send.formats
            ?.filter(({ kind }) => kind === 'textUrl')
            .map(({ offset, length, url }) => ({ offset, length, url })),
        }
      : {}),
    ...(media ? { media } : {}),
    ...(send.album ? { groupedId: `pending:${send.id}` } : {}),
    ...(first && send.reply
      ? presentReply(
          send.reply.messageId,
          send.reply.quoteText,
          messagesById.get(send.reply.messageId),
        )
      : {}),
  };
  return { key: `${send.peer.id}:random:${randomId}`, message: value };
}

export function createConversationPresenter() {
  const cache = new WeakMap<
    EngineSnapshot['messages'][number],
    { reply: EngineSnapshot['messages'][number] | undefined; read: boolean; view: ChatMessage }
  >();
  return (snapshot: Snapshot<EngineSnapshot>, peerId: string) =>
    presentConversation(snapshot, peerId, (message, readOutboxMaxId, reply) => {
      const read = message.outgoing && message.id <= readOutboxMaxId;
      const previous = cache.get(message);
      if (previous && previous.reply === reply && previous.read === read) return previous.view;
      const view = presentMessage(message, readOutboxMaxId, reply);
      cache.set(message, { reply, read, view });
      return view;
    });
}

export function presentConversation(
  snapshot: Snapshot<EngineSnapshot>,
  peerId: string,
  project = presentMessage,
): KeyedMessageView[] {
  if (snapshot.activePeerId !== peerId) return [];
  const readOutboxMaxId =
    snapshot.dialogs.find(({ peer }) => peer.id === peerId)?.readOutboxMaxId ?? 0;
  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]));
  const confirmedRandomIds = new Set(
    snapshot.messages
      .map(({ randomId }) => randomId)
      .filter((randomId): randomId is string => Boolean(randomId)),
  );
  // Telegram can confirm album items in separate updates. Keep the complete local
  // group until every item is present so it never collapses into individual images.
  const incompleteAlbumIds = new Set(
    snapshot.pending
      .filter(
        (send) =>
          send.peer.id === peerId &&
          send.album?.attachments.some(({ randomId }) => !confirmedRandomIds.has(randomId)),
      )
      .flatMap((send) => send.album!.attachments.map(({ randomId }) => randomId)),
  );
  const current = snapshot.messages
    .filter((message) => !message.randomId || !incompleteAlbumIds.has(message.randomId))
    .map((message) => ({
      key: message.randomId
        ? `${message.peerId}:random:${message.randomId}`
        : `${message.peerId}:${message.id}`,
      message: project(
        message,
        readOutboxMaxId,
        message.replyToId ? messagesById.get(message.replyToId) : undefined,
      ),
    }));
  const pending = snapshot.pending
    .filter((send) => send.peer.id === peerId)
    .flatMap((send): KeyedMessageView[] => {
      if (send.album) {
        return send.album.attachments.flatMap((attachment, index) =>
          confirmedRandomIds.has(attachment.randomId) &&
          !incompleteAlbumIds.has(attachment.randomId)
            ? []
            : [
                pendingMessage(
                  send,
                  messagesById,
                  `${send.id}:${index}`,
                  attachment.randomId,
                  attachment,
                  index,
                ),
              ],
        );
      }
      if (confirmedRandomIds.has(send.randomId)) return [];
      return [pendingMessage(send, messagesById, send.id, send.randomId, send.attachment)];
    });
  return [...current, ...pending];
}
