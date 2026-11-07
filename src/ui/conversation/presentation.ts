import type { ChatMessage, ChatSummary } from '../../domain/models';
import { richBlocksToPlainText } from '../../domain/messageText';
import { formatMediaDuration } from '../media/mediaPresentation';
import type {
  PendingAttachment,
  PendingSend,
  TelegramDialog,
  TelegramMessage,
} from '../../telegram/types';

function formatMessageTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(timestamp * 1000),
  );
}

export function mediaPreview(media: NonNullable<ChatMessage['media']>, withDuration = false) {
  const labels: Record<NonNullable<TelegramMessage['media']>['kind'], string> = {
    photo: 'Photo',
    video: 'Video',
    'round-video': 'Video message',
    voice: 'Voice message',
    animation: 'GIF',
    sticker: 'Sticker',
    file: media.name || 'File',
  };
  const duration =
    withDuration && ['voice', 'round-video', 'video'].includes(media.kind)
      ? formatMediaDuration(media.duration)
      : '';
  return [labels[media.kind], duration].filter(Boolean).join(' · ');
}

export function presentReply(replyToId?: number, quote?: string, repliedMessage?: TelegramMessage) {
  return {
    replyTo:
      quote ||
      (repliedMessage
        ? repliedMessage.text ||
          (repliedMessage.media
            ? mediaPreview(repliedMessage.media, true)
            : dialogMessagePreview(repliedMessage))
        : replyToId
          ? 'Message'
          : undefined),
    replyAuthor: repliedMessage
      ? repliedMessage.outgoing
        ? 'You'
        : repliedMessage.senderName || repliedMessage.senderId
      : undefined,
    replyToId,
    replyMedia: repliedMessage?.media,
    replyMediaPeerId: repliedMessage?.peerId,
  };
}

export function dialogMessagePreview(message: TelegramMessage) {
  const text = message.text.trim();
  if (text) return text;
  if (message.service?.text) return message.service.text;
  if (message.poll) return `${message.poll.quiz ? 'Quiz' : 'Poll'}: ${message.poll.question}`;
  if (message.contact)
    return `Contact: ${[message.contact.firstName, message.contact.lastName].filter(Boolean).join(' ')}`;
  const media = message.media ? mediaPreview(message.media) : '';
  if (media) return media;
  if (message.richMessage) {
    return richBlocksToPlainText(message.richMessage.blocks).split('\n').find(Boolean) ?? 'Message';
  }
  return 'Message';
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
    width: attachment.width,
    height: attachment.height,
    duration: attachment.duration,
  };
}

function pendingSendPreview(send: PendingSend) {
  const text = send.text.trim();
  if (text) return text;
  if (send.pollDraft) return `Poll: ${send.pollDraft.question}`;
  if (send.contact) return `Contact: ${send.contact.firstName}`;
  if (send.sticker) return 'Sticker';
  const attachment = send.attachment ?? send.album?.attachments[0];
  return attachment ? mediaPreview(presentPendingAttachment(attachment)) : 'Message';
}

export function createDialogPresenter() {
  const cache = new WeakMap<
    TelegramDialog,
    { pending: PendingSend | undefined; view: ChatSummary }
  >();
  return (dialog: TelegramDialog, pending?: PendingSend) => {
    const previous = cache.get(dialog);
    if (previous && previous.pending === pending) return previous.view;
    const view = presentDialog(dialog, pending);
    cache.set(dialog, { pending, view });
    return view;
  };
}

export function presentDialog(dialog: TelegramDialog, pending?: PendingSend): ChatSummary {
  const topMessage = dialog.topMessage;
  return {
    id: dialog.peer.id,
    title: dialog.title,
    initials: dialog.initials,
    color: dialog.color,
    preview: pending
      ? pendingSendPreview(pending)
      : topMessage
        ? dialogMessagePreview(topMessage)
        : dialog.topMessageId > 0
          ? 'Message'
          : 'No messages yet',
    time: pending
      ? formatMessageTime(Math.floor(pending.createdAt / 1000))
      : topMessage
        ? formatMessageTime(topMessage.date)
        : '',
    ...(!pending && topMessage?.outgoing
      ? {
          lastMessageStatus:
            topMessage.id <= dialog.readOutboxMaxId ? ('read' as const) : ('sent' as const),
        }
      : {}),
    unread: dialog.unreadCount,
    unreadMentions: dialog.unreadMentionsCount,
    unreadReactions: dialog.unreadReactionsCount,
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
    peerId: message.peerId,
    author: message.outgoing ? 'You' : senderName || message.senderId,
    senderId: message.senderId,
    senderHasAvatar: message.senderHasAvatar,
    senderAvatarId: message.senderAvatarId,
    senderColor: message.senderColor,
    senderColorVersion: message.senderColorVersion,
    senderRole: message.senderRole,
    senderRoleKind: message.senderRoleKind,
    body:
      message.text ||
      (message.media || message.contact || message.poll || message.richMessage
        ? ''
        : 'Unsupported message'),
    time: formatMessageTime(message.date),
    date: message.date,
    editedAt: message.editedAt,
    outgoing: message.outgoing,
    protected: message.protected,
    status: message.outgoing && message.id <= readOutboxMaxId ? 'read' : 'sent',
    groupedId: message.groupedId,
    forwardedFrom: message.forwardedFrom,
    service: message.service,
    botKeyboard: message.botKeyboard,
    media: message.media,
    contact: message.contact,
    poll: message.poll,
    mediaUnread: message.mediaUnread,
    reactions: message.reactions,
    mentions: message.mentions,
    links: message.links,
    linkPreview: message.linkPreview,
    comments: message.comments,
    formats: message.formats,
    richMessage: message.richMessage,
    ...presentReply(message.replyToId, message.replyQuote, repliedMessage),
  };
}
