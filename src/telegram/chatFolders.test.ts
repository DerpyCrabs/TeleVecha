import { describe, expect, it } from 'vitest';
import { folderContains, folderInviteSlug, type TelegramChatFolder } from './chatFolders';
import type { TelegramDialog } from './types';
const folder: TelegramChatFolder = {
  id: 2,
  title: 'Work',
  shared: false,
  categories: ['groups'],
  exclusions: ['excludeRead', 'excludeArchived', 'excludeMuted'],
  included: [],
  excluded: [],
  pinned: [],
};
const dialog: TelegramDialog = {
  peer: { id: 'c:1', kind: 'channel' },
  title: 'Group',
  initials: 'G',
  color: '',
  hasAvatar: false,
  topMessageId: 1,
  unreadCount: 0,
  readInboxMaxId: 1,
  readOutboxMaxId: 1,
  muted: false,
  pinned: false,
  broadcast: false,
};
describe('Telegram folder membership', () => {
  it('includes manually unread supergroups and excludes read/broadcast chats', () => {
    expect(folderContains(folder, dialog)).toBe(false);
    expect(folderContains(folder, { ...dialog, unreadMark: true })).toBe(true);
    expect(folderContains(folder, { ...dialog, unreadCount: 1, broadcast: true })).toBe(false);
  });
  it('explicit include overrides automatic exclusions; explicit exclude wins', () => {
    expect(
      folderContains(
        { ...folder, included: [dialog.peer] },
        { ...dialog, archived: true, muted: true },
      ),
    ).toBe(true);
    expect(
      folderContains({ ...folder, included: [dialog.peer], excluded: [dialog.peer] }, dialog),
    ).toBe(false);
  });
  it('keeps bots separate from contacts', () => {
    const user = {
      ...dialog,
      peer: { id: 'u:1', kind: 'user' as const },
      isContact: true,
      unreadCount: 1,
    };
    expect(folderContains({ ...folder, categories: ['contacts'] }, user)).toBe(true);
    expect(folderContains({ ...folder, categories: ['contacts'] }, { ...user, bot: true })).toBe(
      false,
    );
  });
  it('parses Telegram folder links without accepting another host', () => {
    expect(folderInviteSlug('https://t.me/addlist/abc-123')).toBe('abc-123');
    expect(folderInviteSlug('tg://addlist?slug=abc')).toBe('abc');
    expect(folderInviteSlug('https://evil.example/addlist/abc')).toBeUndefined();
  });
});
