import type { ChatMessage, ChatSummary } from '../../domain/models';
import type { TelegramDialog } from '../../telegram/types';

export interface MessageLayout {
  album: readonly ChatMessage[];
  author: string;
  caption: ChatMessage;
  className: string;
  compactAfter: boolean;
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
    previous.compactAfter === next.compactAfter &&
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

function isImageDocument(message: ChatMessage) {
  return message.media?.kind === 'file' && message.media.mimeType.startsWith('image/');
}

function sameSender(first: ChatMessage | undefined, second: ChatMessage | undefined) {
  const sameIdentity = Boolean(
    first &&
    second &&
    ((first.outgoing && second.outgoing) || (first.senderId && first.senderId === second.senderId)),
  );
  return Boolean(
    first &&
    second &&
    !first.service &&
    !second.service &&
    sameIdentity &&
    first.date !== undefined &&
    second.date !== undefined &&
    new Date(first.date * 1000).toDateString() === new Date(second.date * 1000).toDateString(),
  );
}

function captionMediaWidth(parts: Array<string | undefined>) {
  const longestLine = parts
    .flatMap((part) => (part ?? '').split('\n'))
    .reduce((longest, line) => Math.max(longest, Array.from(line).length), 0);
  // Telegram Desktop expands bubble media to textualMaxWidth, while still
  // clamping it to the message/media maximum. This approximates its font
  // measurement in rem without coupling layout code to a canvas.
  return Math.min(24, 1.3 + longestLine * 0.48);
}

function dialogTitles(dialogs: readonly TelegramDialog[]) {
  const titles = new Map<string, string>();
  for (const { peer, title } of dialogs) if (!titles.has(peer.id)) titles.set(peer.id, title);
  return titles;
}

export function layoutMessages(
  messages: ChatMessage[],
  chat: ChatSummary,
  dialogs: readonly TelegramDialog[],
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
  const titles = dialogTitles(dialogs);
  const author = (message: ChatMessage) => {
    if (message.outgoing || chat.kind === 'user') return '';
    return titles.get(message.author) || message.author || chat.title;
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
      (album.length > 1 || isVisualMedia(message)) &&
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
      (!message.media || isImageDocument(message)) &&
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
      message.status !== 'failed' &&
      !message.linkPreview,
    );
    const mediaWidth = (() => {
      if (album.length > 1) {
        return 'min(24rem, 100%)';
      }
      if (isImageDocument(message)) return 'min(16.75rem, 100%)';
      // Keep the voice waveform usable even when the message has no caption.
      if (message.media?.kind === 'voice') return 'min(20rem, 100%)';
      if (!isVisualMedia(message) || message.status === 'failed') {
        return undefined;
      }
      const width = message.media?.width;
      const height = message.media?.height;
      const photoWidth = width && height ? Math.max(12, Math.min(20, (24 * width) / height)) : 20;
      const textWidth = captionedMedia
        ? captionMediaWidth([caption.body, messageAuthor, forwardedFrom?.name, message.replyTo])
        : 0;
      return `min(${Math.max(photoWidth, textWidth)}rem, 100%)`;
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
      (chat.kind === 'channel' || chat.kind === 'group') &&
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
    const className = `message ${message.outgoing ? 'outgoing' : 'incoming'}${message.service ? ' message-service' : ''}${sameSender(previousVisible(index), message) ? ' message-same-sender' : ''}${album.length > 1 ? ' message-has-album' : ''}${isImageDocument(message) ? ' message-image-document' : ''}${mediaOnly ? ' message-media-surface' : ''}${inlineTime ? ' message-inline-time' : ''}${captionedMedia ? ' message-captioned-media' : ''}${cropped ? ' message-media-cropped' : ''}`;
    const layout = {
      album,
      author: messageAuthor,
      caption,
      className,
      compactAfter: sameSender(previousVisible(nextIndex), messages[nextIndex]),
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

/** Layout depends on immutable messages and sender metadata, not composer or appearance state. */
export function createMessageLayout() {
  let previous:
    | {
        messages: ChatMessage[];
        kind: ChatSummary['kind'];
        title: string;
        dialogs: readonly TelegramDialog[];
        titles: Map<string, string>;
        result: MessageLayout[];
      }
    | undefined;
  return (messages: ChatMessage[], chat: ChatSummary, dialogs: readonly TelegramDialog[]) => {
    const titles =
      previous && previous.dialogs === dialogs ? previous.titles : dialogTitles(dialogs);
    const previousTitles = previous?.titles;
    const sameTitles =
      previousTitles &&
      (previousTitles === titles ||
        (previousTitles.size === titles.size &&
          [...titles].every(([id, title]) => previousTitles.get(id) === title)));
    if (
      previous &&
      previous.messages === messages &&
      previous.kind === chat.kind &&
      previous.title === chat.title &&
      sameTitles
    ) {
      previous.dialogs = dialogs;
      previous.titles = titles;
      return previous.result;
    }
    const result = layoutMessages(messages, chat, dialogs, previous?.result);
    previous = { messages, kind: chat.kind, title: chat.title, dialogs, titles, result };
    return result;
  };
}
