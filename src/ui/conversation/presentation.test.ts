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
