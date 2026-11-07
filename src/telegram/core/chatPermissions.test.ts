import { pendingPoll } from '../../domain/poll';
import { describe, expect, it } from 'vitest';

import type { TelegramChatPermissions, TelegramDialog, TelegramMessage } from '../types';
import {
  canSendMessageToDialog,
  deleteDialogOptions,
  messageCapabilities,
} from './chatPermissions';

const basePermissions: TelegramChatPermissions = {
  canSendMessages: true,
  canSendMedia: true,
  canSendStickers: true,
  canSendGifs: true,
  canPinMessages: true,
  canEditMessages: false,
  canDeleteMessages: true,
  canDeleteForEveryone: true,
  canDeleteChat: false,
  canDeleteChannel: false,
  canLeave: true,
  canViewMembers: true,
};

function dialog(
  kind: TelegramDialog['peer']['kind'],
  overrides: Partial<TelegramChatPermissions> = {},
): TelegramDialog {
  return {
    peer: { id: `${kind}:1`, kind },
    title: 'Test chat',
    initials: 'TC',
    color: '#000',
    topMessageId: 1,
    unreadCount: 0,
    readInboxMaxId: 0,
    readOutboxMaxId: 0,
    muted: false,
    pinned: false,
    hasAvatar: false,
    permissions: { ...basePermissions, ...overrides },
  };
}

function message(
  overrides: Partial<
    Pick<
      TelegramMessage,
      'outgoing' | 'protected' | 'service' | 'forwardedFrom' | 'media' | 'contact' | 'poll'
    >
  > = {},
) {
  return { outgoing: true, text: 'Hello', ...overrides };
}

describe('Telegram chat permissions', () => {
  it('keeps contact cards and polls out of the text editor', () => {
    expect(
      messageCapabilities(
        dialog('user'),
        message({ contact: { firstName: 'Ada', lastName: '', phoneNumber: '+123', vcard: '' } }),
      ).canEdit,
    ).toBe(false);
    const poll = pendingPoll(
      {
        question: 'Question',
        answers: ['A', 'B'],
        quiz: false,
        multipleChoice: false,
        publicVoters: false,
        solution: '',
      },
      '1',
    );
    expect(messageCapabilities(dialog('user'), message({ poll })).canEdit).toBe(false);
  });
  it('does not offer local channel deletion or editing for non-editable media', () => {
    const channel = dialog('channel');
    const sticker = message({
      outgoing: false,
      media: { kind: 'sticker', name: 'sticker', mimeType: 'image/webp' },
    });

    expect(messageCapabilities(channel, sticker)).toMatchObject({
      canDeleteForMe: false,
      canDeleteForEveryone: true,
      canEdit: false,
    });
    expect(deleteDialogOptions(channel)).toEqual([expect.objectContaining({ action: 'leave' })]);
  });

  it('keeps private chat clear and revoke actions distinct', () => {
    expect(deleteDialogOptions(dialog('user'))).toEqual([
      expect.objectContaining({ action: 'clear-for-me' }),
      expect.objectContaining({ action: 'delete-for-everyone' }),
    ]);
  });

  it('does not let private-chat permissions edit incoming messages', () => {
    expect(
      messageCapabilities(dialog('user'), {
        outgoing: false,
        protected: false,
        service: undefined,
        forwardedFrom: undefined,
        media: undefined,
        text: 'Incoming',
      }),
    ).toMatchObject({ canEdit: false });
  });

  it('shows leave to group members and delete to group owners', () => {
    expect(deleteDialogOptions(dialog('group', { canDeleteChat: false }))).toEqual([
      expect.objectContaining({ action: 'leave' }),
    ]);
    expect(deleteDialogOptions(dialog('group', { canDeleteChat: true }))).toEqual([
      expect.objectContaining({ action: 'delete-chat' }),
    ]);
  });

  it('applies media-specific send restrictions to forwarding', () => {
    const target = dialog('group', { canSendMedia: false });
    expect(
      canSendMessageToDialog(target, {
        media: { kind: 'photo', name: 'photo', mimeType: 'image/jpeg' },
      }),
    ).toBe(false);
    expect(canSendMessageToDialog(target)).toBe(true);
  });
});
