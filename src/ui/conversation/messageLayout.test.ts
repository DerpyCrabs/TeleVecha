import { describe, expect, it } from 'vitest';

import type { ChatMessage, ChatSummary } from '../../domain/models';
import { layoutMessages } from './messageLayout';

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
      className: expect.stringContaining('message-has-album'),
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
});
