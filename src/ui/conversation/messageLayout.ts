import type { ChatMessage, ChatSummary } from '../../domain/models';
import type { TelegramDialog } from '../../telegram/types';

export interface MessageLayout {
  album: ChatMessage[];
  author: string;
  caption: ChatMessage;
  className: string;
  forwardedFrom: ChatMessage['forwardedFrom'] | undefined;
  hide: boolean;
  media: ChatMessage['media'] | undefined;
  showDateDivider: boolean;
  showSenderAvatar: boolean;
  width: string | undefined;
}

function sameLayout(previous: MessageLayout | undefined, next: MessageLayout) {
  return Boolean(
    previous &&
    previous.author === next.author &&
    previous.caption === next.caption &&
    previous.className === next.className &&
    previous.forwardedFrom === next.forwardedFrom &&
    previous.hide === next.hide &&
    previous.media === next.media &&
    previous.showDateDivider === next.showDateDivider &&
    previous.showSenderAvatar === next.showSenderAvatar &&
    previous.width === next.width &&
    previous.album.length === next.album.length &&
    previous.album.every((message, index) => message === next.album[index]),
  );
}

function isVisualMedia(message: ChatMessage) {
  return (
    message.media?.kind === 'photo' ||
    message.media?.kind === 'video' ||
    (message.media?.kind === 'animation' && message.media.mimeType.startsWith('video/'))
  );
}

function sameSender(first: ChatMessage | undefined, second: ChatMessage | undefined) {
  return Boolean(
    first &&
    second &&
    !first.service &&
    !second.service &&
    first.senderId &&
    first.senderId === second.senderId &&
    first.date !== undefined &&
    second.date !== undefined &&
    new Date(first.date * 1000).toDateString() === new Date(second.date * 1000).toDateString(),
  );
}

export function layoutMessages(
  messages: ChatMessage[],
  chat: ChatSummary,
  dialogs: TelegramDialog[],
  previous: MessageLayout[] = [],
): MessageLayout[] {
  const continuations = messages.map((message, index) =>
    Boolean(message.groupedId && index > 0 && messages[index - 1]?.groupedId === message.groupedId),
  );
  const albums = messages.map((message, index) => {
    if (!message.groupedId || continuations[index]) return [];
    const grouped: ChatMessage[] = [];
    for (let cursor = index; cursor < messages.length; cursor += 1) {
      const candidate = messages[cursor];
      if (!candidate || candidate.groupedId !== message.groupedId) break;
      if (candidate.media) grouped.push(candidate);
    }
    return grouped.length > 1 ? grouped : [];
  });
  const author = (message: ChatMessage) => {
    if (message.outgoing || chat.kind === 'user') return '';
    return (
      dialogs.find(({ peer }) => peer.id === message.author)?.title || message.author || chat.title
    );
  };
  const previousVisible = (index: number) => {
    let previousIndex = index - 1;
    while (previousIndex >= 0 && continuations[previousIndex]) previousIndex -= 1;
    return messages[previousIndex];
  };

  const next = messages.map((message, index) => {
    const album = albums[index] ?? [];
    const caption = album.find(({ body }) => Boolean(body)) ?? message;
    const forwardedFrom =
      message.forwardedFrom ??
      caption.forwardedFrom ??
      album.find((albumMessage) => albumMessage.forwardedFrom)?.forwardedFrom;
    const messageAuthor = sameSender(previousVisible(index), message) ? '' : author(message);
    const mediaOnly = Boolean(
      ((album.length > 1 && album.every(({ uploadProgress }) => uploadProgress === undefined)) ||
        (isVisualMedia(message) && message.uploadProgress === undefined)) &&
      !caption.body.trim() &&
      !messageAuthor &&
      !forwardedFrom &&
      !message.replyTo &&
      !message.linkPreview &&
      !message.botKeyboard &&
      !message.reactions?.length &&
      message.status !== 'failed',
    );
    const inlineTime = Boolean(
      !message.service &&
      album.length === 0 &&
      !message.media &&
      message.body.trim() &&
      !message.linkPreview &&
      message.botKeyboard?.kind !== 'inline',
    );
    const captionedMedia = Boolean(
      !message.service &&
      (album.length > 1 || isVisualMedia(message)) &&
      (caption.body.trim() ||
        messageAuthor ||
        forwardedFrom ||
        message.replyTo ||
        message.botKeyboard ||
        message.reactions?.length) &&
      (album.length > 1
        ? album.every(({ uploadProgress }) => uploadProgress === undefined)
        : message.uploadProgress === undefined) &&
      message.status !== 'failed' &&
      !message.linkPreview,
    );
    const mediaWidth = (() => {
      if (album.length > 1) {
        return album.every(({ uploadProgress }) => uploadProgress === undefined) &&
          message.status !== 'failed'
          ? 'min(24rem, 100%)'
          : undefined;
      }
      if (
        !isVisualMedia(message) ||
        message.uploadProgress !== undefined ||
        message.status === 'failed'
      ) {
        return undefined;
      }
      const width = message.media?.width;
      const height = message.media?.height;
      if (!width || !height) return 'min(20rem, 100%)';
      return `min(${Math.max(12, Math.min(20, (24 * width) / height))}rem, 100%)`;
    })();
    const cropped = (() => {
      if (album.length > 1 || !isVisualMedia(message)) return false;
      const width = message.media?.width;
      const height = message.media?.height;
      return Boolean(width && height && width / height < 0.5);
    })();
    let nextIndex = index + 1;
    while (nextIndex < messages.length && continuations[nextIndex]) nextIndex += 1;
    const showSenderAvatar = Boolean(
      chat.kind === 'channel' &&
      !message.outgoing &&
      !message.service &&
      message.senderId &&
      !continuations[index] &&
      !sameSender(message, messages[nextIndex]),
    );
    const showDateDivider = Boolean(
      message.date !== undefined &&
      (index === 0 ||
        new Date(message.date * 1000).toDateString() !==
          new Date((messages[index - 1]?.date ?? message.date) * 1000).toDateString()),
    );
    const className = `message ${message.outgoing ? 'outgoing' : 'incoming'}${message.service ? ' message-service' : ''}${sameSender(previousVisible(index), message) ? ' message-same-sender' : ''}${album.length > 1 ? ' message-has-album' : ''}${mediaOnly ? ' message-media-surface' : ''}${inlineTime ? ' message-inline-time' : ''}${captionedMedia ? ' message-captioned-media' : ''}${cropped ? ' message-media-cropped' : ''}`;
    const layout = {
      album,
      author: messageAuthor,
      caption,
      className,
      forwardedFrom,
      hide: continuations[index] ?? false,
      media: album.length === 0 ? message.media : undefined,
      showDateDivider,
      showSenderAvatar,
      width: mediaWidth,
    };
    return sameLayout(previous[index], layout) ? previous[index]! : layout;
  });
  return previous.length === next.length &&
    previous.every((layout, index) => layout === next[index])
    ? previous
    : next;
}
