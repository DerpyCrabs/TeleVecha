import type { ChatMessage, ChatSummary } from '../../domain/models';
import type { PendingAttachment, TelegramDialog, TelegramMessage } from '../../telegram/types';

function formatMessageTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(timestamp * 1000),
  );
}

export function presentPendingAttachment(
  attachment: PendingAttachment,
): NonNullable<ChatMessage['media']> {
  const kind = attachment.asSticker
    ? 'sticker'
    : attachment.sendAs === 'file'
      ? 'file'
      : attachment.mimeType === 'image/gif'
        ? 'animation'
        : attachment.mimeType.startsWith('image/')
          ? 'photo'
          : attachment.mimeType.startsWith('video/')
            ? 'video'
            : 'file';
  return {
    kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.blob.size,
  };
}

export function presentDialog(dialog: TelegramDialog): ChatSummary {
  return {
    id: dialog.peer.id,
    title: dialog.title,
    initials: dialog.initials,
    color: dialog.color,
    preview: dialog.topMessage?.text || 'No messages yet',
    time: dialog.topMessage ? formatMessageTime(dialog.topMessage.date) : '',
    unread: dialog.unreadCount,
    muted: dialog.muted,
    pinned: dialog.pinned,
    archived: Boolean(dialog.archived),
    ...(dialog.username ? { username: dialog.username } : {}),
    bot: Boolean(dialog.bot),
    ...(dialog.presence ? { presence: dialog.presence } : {}),
    lastSeenAt: dialog.lastSeenAt,
    kind: dialog.peer.kind,
  };
}

export function presentMessage(
  message: TelegramMessage,
  readOutboxMaxId: number,
  repliedMessage?: TelegramMessage,
): ChatMessage {
  const senderName = (message as TelegramMessage & { senderName?: string }).senderName;
  return {
    id: String(message.id),
    author: message.outgoing ? 'You' : senderName || message.senderId,
    senderId: message.senderId,
    senderHasAvatar: message.senderHasAvatar,
    senderAvatarId: message.senderAvatarId,
    senderColor: message.senderColor,
    senderColorVersion: message.senderColorVersion,
    senderRole: message.senderRole,
    senderRoleKind: message.senderRoleKind,
    body: message.text || (message.media || message.richMessage ? '' : 'Unsupported message'),
    time: formatMessageTime(message.date),
    date: message.date,
    editedAt: message.editedAt,
    outgoing: message.outgoing,
    status: message.outgoing && message.id <= readOutboxMaxId ? 'read' : 'sent',
    groupedId: message.groupedId,
    forwardedFrom: message.forwardedFrom,
    service: message.service,
    botKeyboard: message.botKeyboard,
    media: message.media,
    reactions: message.reactions,
    mentions: message.mentions,
    links: message.links,
    linkPreview: message.linkPreview,
    formats: message.formats,
    richMessage: message.richMessage,
    replyTo: message.replyQuote || repliedMessage?.text || repliedMessage?.media?.name || undefined,
    replyToId: message.replyToId,
    replyMedia: repliedMessage?.media,
    replyMediaPeerId: repliedMessage?.peerId,
  };
}
