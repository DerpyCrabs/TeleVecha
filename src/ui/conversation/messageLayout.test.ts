import { describe, expect, it } from 'vitest';

import type { ChatMessage, ChatSummary } from '../../domain/models';
import { createMessageLayout, layoutMessages } from './messageLayout';

const chat: ChatSummary = {
  id: 'channel:1',
  title: 'Channel',
  initials: 'C',
  color: '#123456',
  preview: '',
  time: '',
  unread: 0,
  kind: 'channel',
};

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    author: 'user:2',
    senderId: 'user:2',
    body: 'Message',
    time: '12:00',
    date: 1_700_000_000,
    outgoing: false,
    status: 'sent',
    ...overrides,
  };
}

describe('layoutMessages', () => {
  it('uses forwarded-source metadata from any message in an album', () => {
    const media = { kind: 'photo' as const, name: 'photo.jpg', mimeType: 'image/jpeg' };
    const layouts = layoutMessages(
      [
        message('1', { groupedId: 'album', media, body: '' }),
        message('2', {
          groupedId: 'album',
          media,
          body: 'Caption',
          forwardedFrom: { name: 'Source Channel', peerId: 'c:5', messageId: 9 },
        }),
      ],
      chat,
      [],
    );

    expect(layouts[0]?.forwardedFrom).toEqual({
      name: 'Source Channel',
      peerId: 'c:5',
      messageId: 9,
    });
  });

  it('groups an album behind its first message', () => {
    const media = { kind: 'photo' as const, name: 'photo.jpg', mimeType: 'image/jpeg' };
    const layouts = layoutMessages(
      [
        message('1', { groupedId: 'album', media, body: 'Caption' }),
        message('2', { groupedId: 'album', media, body: '' }),
      ],
      chat,
      [],
    );

    expect(layouts[0]).toMatchObject({
      hide: false,
      caption: { body: 'Caption' },
      className: expect.stringContaining('message-has-album') as unknown,
    });
    expect(layouts[0]?.album).toHaveLength(2);
    expect(layouts[1]?.hide).toBe(true);
  });

  it('groups consecutive channel posts by sender and shows one trailing avatar', () => {
    const layouts = layoutMessages([message('1'), message('2')], chat, []);

    expect(layouts[0]?.author).toBe('user:2');
    expect(layouts[1]?.author).toBe('');
    expect(layouts[0]?.showSenderAvatar).toBe(false);
    expect(layouts[1]?.showSenderAvatar).toBe(true);
    expect(layouts[1]?.className).toContain('message-same-sender');
    expect(layouts[0]?.compactAfter).toBe(true);
    expect(layouts[1]?.compactAfter).toBe(false);
  });

  it('computes spacing across hidden album rows and sender/date boundaries', () => {
    const media = { kind: 'photo' as const, name: 'photo.jpg', mimeType: 'image/jpeg' };
    const messages = [
      message('1'),
      message('2', { groupedId: 'album', media }),
      message('3', { groupedId: 'album', media, body: '' }),
      message('4', { senderId: 'user:3' }),
      message('5', { senderId: 'user:3', date: 1_700_086_400 }),
    ];
    const layouts = layoutMessages(messages, chat, []);
    expect(layouts.map(({ compactAfter }) => compactAfter)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(layouts[2]?.hide).toBe(true);

    const next = layoutMessages([...messages, message('6')], chat, [], layouts);
    expect(next[0]).toBe(layouts[0]);
    expect(next[1]).toBe(layouts[1]);
  });

  it('groups consecutive outgoing messages even when Telegram omits their sender id', () => {
    const outgoing = (id: string, fields: Partial<ChatMessage> = {}) =>
      message(id, { outgoing: true, senderId: '', ...fields });
    const layouts = layoutMessages(
      [
        outgoing('1'),
        outgoing('2', { media: { kind: 'photo', name: 'photo.jpg', mimeType: 'image/jpeg' } }),
        outgoing('3', { replyToId: 1, replyTo: 'quoted' }),
      ],
      { ...chat, kind: 'user' },
      [],
    );

    expect(layouts[1]?.className).toContain('message-same-sender');
    expect(layouts[2]?.className).toContain('message-same-sender');
  });

  it('derives media framing and width without caller-side rules', () => {
    const [layout] = layoutMessages(
      [
        message('1', {
          author: '',
          body: '',
          media: {
            kind: 'photo',
            name: 'portrait.jpg',
            mimeType: 'image/jpeg',
            width: 400,
            height: 1_000,
          },
        }),
      ],
      { ...chat, kind: 'user' },
      [],
    );

    expect(layout?.className).toContain('message-media-surface');
    expect(layout?.className).toContain('message-media-cropped');
    expect(layout?.width).toBe('min(12rem, 100%)');
  });

  it('widens an extreme portrait bubble to fit a long caption like Telegram Desktop', () => {
    const [layout] = layoutMessages(
      [
        message('1', {
          body: 'A long caption that should determine the bubble width instead of the portrait aspect ratio.',
          forwardedFrom: { name: 'A channel with a long title' },
          media: {
            kind: 'photo',
            name: 'portrait.jpg',
            mimeType: 'image/jpeg',
            width: 100,
            height: 1_000,
          },
        }),
      ],
      { ...chat, kind: 'user' },
      [],
    );

    expect(layout?.className).toContain('message-media-cropped');
    expect(layout?.className).toContain('message-captioned-media');
    expect(layout?.width).toBe('min(24rem, 100%)');
  });

  it('uses Telegram Desktop document width for thumbnail files', () => {
    const [layout] = layoutMessages(
      [
        message('1', {
          body: 'caption',
          replyTo: 'A reply whose full text must not widen the document',
          media: { kind: 'file', name: 'image.png', mimeType: 'image/png' },
        }),
      ],
      { ...chat, kind: 'user' },
      [],
    );

    expect(layout?.className).toContain('message-image-document');
    expect(layout?.width).toBe('min(16.75rem, 100%)');
  });
});

it('caches layout inputs without hiding sender, date, album or status changes', () => {
  const layout = createMessageLayout();
  const messages = [message('1'), message('2')];
  const dialogs: Parameters<typeof layoutMessages>[2] = [];
  const initial = layout(messages, chat, dialogs);
  expect(layout(messages, { ...chat, unread: 8, preview: 'Unrelated' }, dialogs)).toBe(initial);
  expect(layout(messages, { ...chat, kind: 'user' }, dialogs)[0]!.author).toBe('');
  const later = layout(
    [messages[0]!, message('2', { date: 1_700_100_000, status: 'failed' })],
    chat,
    dialogs,
  );
  expect(later[1]!.showDateDivider).toBe(true);
  expect(later[1]!.caption.status).toBe('failed');
  const media = { kind: 'photo' as const, name: 'photo', mimeType: 'image/jpeg' };
  const album = layout(
    messages.map((entry) => ({ ...entry, media, groupedId: 'album' })),
    chat,
    dialogs,
  );
  expect(album[0]!.album).toHaveLength(2);
  expect(album[1]!.hide).toBe(true);
});

it('updates sender titles but ignores read/unread metadata when caching layouts', () => {
  const layout = createMessageLayout();
  const messages = [message('1')];
  const dialog = {
    peer: { id: 'user:2', kind: 'user' as const },
    title: 'Alice',
    initials: 'A',
    color: '#123456',
    unreadCount: 0,
    muted: false,
    pinned: false,
    topMessageId: 1,
    readInboxMaxId: 1,
    readOutboxMaxId: 1,
    hasAvatar: false,
  };
  const initial = layout(messages, chat, [dialog]);
  expect(initial[0]!.author).toBe('Alice');
  expect(layout(messages, chat, [{ ...dialog, unreadCount: 10, readOutboxMaxId: 5 }])).toBe(
    initial,
  );
  expect(layout(messages, chat, [{ ...dialog, title: 'Renamed' }])[0]!.author).toBe('Renamed');
});
