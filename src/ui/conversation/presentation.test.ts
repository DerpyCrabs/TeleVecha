import { describe, expect, it } from 'vitest';

import type { TelegramDialog, TelegramMessage } from '../../telegram/types';
import { presentDialog, presentMessage, presentPendingAttachment } from './presentation';

const peer = { id: 'user:1', kind: 'user' as const, accessHash: '1' };

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    id: 4,
    peerId: peer.id,
    senderId: 'user:2',
    text: 'Hello',
    date: 1_700_000_000,
    outgoing: false,
    ...overrides,
  };
}

describe('presentation', () => {
  it('presents a dialog without exposing Telegram cache details', () => {
    const dialog: TelegramDialog = {
      peer,
      title: 'Alice',
      initials: 'A',
      color: '#123456',
      unreadCount: 3,
      muted: false,
      pinned: true,
      topMessageId: 4,
      readInboxMaxId: 1,
      readOutboxMaxId: 2,
      hasAvatar: false,
      topMessage: message(),
    };

    expect(presentDialog(dialog)).toMatchObject({
      id: peer.id,
      title: 'Alice',
      preview: 'Hello',
      unread: 3,
      pinned: true,
      kind: 'user',
    });
  });

  it('derives read and reply presentation from related messages', () => {
    const reply = message({ id: 2, text: 'Earlier' });
    expect(presentMessage(message({ outgoing: true, replyToId: 2 }), 4, reply)).toMatchObject({
      id: '4',
      author: 'You',
      status: 'read',
      replyTo: 'Earlier',
      replyToId: 2,
    });
  });

  it('presents media and outgoing delivery state without claiming the dialog is empty', () => {
    const dialog: TelegramDialog = {
      peer,
      title: 'Alice',
      initials: 'A',
      color: '#123456',
      unreadCount: 0,
      muted: true,
      pinned: false,
      topMessageId: 8,
      readInboxMaxId: 0,
      readOutboxMaxId: 8,
      hasAvatar: false,
      topMessage: message({
        id: 8,
        text: '',
        outgoing: true,
        media: { kind: 'photo', name: 'photo.jpg', mimeType: 'image/jpeg' },
      }),
    };

    expect(presentDialog(dialog)).toMatchObject({
      preview: 'Photo',
      lastMessageStatus: 'read',
      muted: true,
    });
  });

  it('distinguishes an uncached top message from a genuinely empty dialog', () => {
    const base: TelegramDialog = {
      peer,
      title: 'Alice',
      initials: 'A',
      color: '#123456',
      unreadCount: 0,
      muted: false,
      pinned: false,
      topMessageId: 9,
      readInboxMaxId: 0,
      readOutboxMaxId: 0,
      hasAvatar: false,
    };

    expect(presentDialog(base).preview).toBe('Message');
    expect(presentDialog({ ...base, topMessageId: 0 }).preview).toBe('No messages yet');
  });

  it('keeps the forwarded message source', () => {
    expect(
      presentMessage(
        message({
          forwardedFrom: { name: 'Release Channel', peerId: 'c:202', messageId: 17 },
        }),
        0,
      ).forwardedFrom,
    ).toEqual({ name: 'Release Channel', peerId: 'c:202', messageId: 17 });
  });

  it('classifies pending media in one place', () => {
    expect(
      presentPendingAttachment({
        blob: new Blob(['gif']),
        name: 'reaction.gif',
        mimeType: 'image/gif',
        asSticker: false,
        sendAs: 'media',
      }),
    ).toMatchObject({ kind: 'animation', name: 'reaction.gif', size: 3 });
  });
});
