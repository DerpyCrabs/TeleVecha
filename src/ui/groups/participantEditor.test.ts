import { expect, it } from 'vitest';
import { expandedRestrictions, newAdminRights, visibleAdminRights } from './participantEditor';
import type { ChatManagementSettings } from '../../telegram/chatManagement';
const settings: ChatManagementSettings = {
  title: 'Team',
  about: '',
  username: '',
  broadcast: false,
  forum: false,
  slowModeSeconds: 0,
  hiddenHistory: false,
  protectedContent: false,
  grantableAdminRights: { deleteMessages: true, inviteUsers: true, addAdmins: true },
  rights: {
    changeInfo: false,
    changeType: false,
    manageInvites: true,
    manageAdmins: true,
    restrictMembers: false,
    manageTopics: false,
    viewLog: true,
  },
};
it('does not grant rights outside the current administrator ceiling', () => {
  const rights = newAdminRights(settings);
  expect(rights.deleteMessages).toBe(true);
  expect(rights.inviteUsers).toBe(true);
  expect(rights.banUsers).toBe(false);
  expect(rights.addAdmins).toBe(false);
  expect(rights.anonymous).toBe(false);
  expect(visibleAdminRights(settings)).not.toContain('postMessages');
  expect(visibleAdminRights(settings)).not.toContain('manageTopics');
});
it('expands legacy message bans so editing one permission preserves the others', () => {
  const rights = expandedRestrictions({ sendMessages: true, inviteUsers: true });
  expect(rights).toMatchObject({
    sendMessages: false,
    sendMedia: false,
    sendPlain: true,
    sendPhotos: true,
    sendPolls: true,
    sendStickers: true,
    inviteUsers: true,
  });
  rights.sendPhotos = false;
  expect(rights.sendVideos).toBe(true);
  expect(rights.sendPlain).toBe(true);
});
it('keeps text available under a media-only ban', () => {
  const rights = expandedRestrictions({ sendMedia: true });
  expect(rights.sendPhotos).toBe(true);
  expect(rights.sendDocs).toBe(true);
  expect(rights.sendPlain).toBeUndefined();
});
