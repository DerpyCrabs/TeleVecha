import {
  adminRightKeys,
  type ChatAdminRights,
  type ChatRestrictions,
  type ChatManagementSettings,
} from '../../telegram/chatManagement';
export const adminLabels: Record<(typeof adminRightKeys)[number], string> = {
  changeInfo: 'Change chat info',
  postMessages: 'Post messages',
  editMessages: 'Edit messages',
  deleteMessages: 'Delete messages',
  banUsers: 'Ban users',
  inviteUsers: 'Invite users',
  pinMessages: 'Pin messages',
  addAdmins: 'Add administrators',
  anonymous: 'Remain anonymous',
  manageCall: 'Manage video chats',
  other: 'Manage chat',
  manageTopics: 'Manage topics',
  postStories: 'Post stories',
  editStories: 'Edit stories',
  deleteStories: 'Delete stories',
  manageDirectMessages: 'Manage direct messages',
  manageRanks: 'Manage member tags',
  manageLinkedPeers: 'Manage linked chats',
};
export const permissionLabels = {
  sendPlain: 'Send text messages',
  sendPhotos: 'Send photos',
  sendVideos: 'Send videos',
  sendRoundvideos: 'Send video messages',
  sendAudios: 'Send music',
  sendVoices: 'Send voice messages',
  sendDocs: 'Send files',
  sendStickers: 'Send stickers',
  sendGifs: 'Send GIFs',
  sendGames: 'Send games',
  sendInline: 'Use inline bots',
  embedLinks: 'Embed links',
  sendPolls: 'Send polls',
  sendReactions: 'Send reactions',
  inviteUsers: 'Add users',
  pinMessages: 'Pin messages',
  changeInfo: 'Change chat info',
  manageTopics: 'Create topics',
  editRank: 'Change member tag',
  manageLinkedPeers: 'Manage linked chats',
} satisfies Partial<Record<keyof ChatRestrictions, string>>;
export const permissionKeys = Object.keys(permissionLabels) as (keyof typeof permissionLabels)[];
export function expandedRestrictions(value: ChatRestrictions): ChatRestrictions {
  const next = { ...value, sendMessages: false, sendMedia: false };
  const media = [
    'sendPhotos',
    'sendVideos',
    'sendRoundvideos',
    'sendAudios',
    'sendVoices',
    'sendDocs',
  ] as const;
  if (value.sendMedia || value.sendMessages) for (const key of media) next[key] = true;
  if (value.sendMessages)
    for (const key of [
      'sendPlain',
      'sendStickers',
      'sendGifs',
      'sendGames',
      'sendInline',
      'embedLinks',
      'sendPolls',
    ] as const)
      next[key] = true;
  return next;
}
export function visibleAdminRights(settings: ChatManagementSettings) {
  return adminRightKeys.filter(
    (key) =>
      (settings.broadcast ||
        !['postMessages', 'editMessages', 'manageDirectMessages'].includes(key)) &&
      (!settings.broadcast || key !== 'anonymous') &&
      (settings.forum || key !== 'manageTopics'),
  );
}
export function newAdminRights(settings: ChatManagementSettings): ChatAdminRights {
  return Object.fromEntries(
    visibleAdminRights(settings).map((key) => [
      key,
      Boolean(settings.grantableAdminRights?.[key]) &&
        !['addAdmins', 'anonymous', 'other'].includes(key),
    ]),
  );
}
