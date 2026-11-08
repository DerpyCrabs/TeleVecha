import type { Effect } from 'effect';
import type { TelegramPeer } from './types';

export interface CreateChatRequest {
  kind: 'group' | 'channel';
  title: string;
  about?: string | undefined;
  users: TelegramPeer[];
}
export interface CreatedChat {
  peer: TelegramPeer;
  missingUserIds: string[];
}
export interface ChatCreationApi {
  createChat(request: CreateChatRequest): Effect.Effect<CreatedChat, unknown>;
}

export interface ChatInvitePreview {
  title: string;
  about: string;
  participantsCount: number;
  broadcast: boolean;
  requestNeeded: boolean;
  alreadyJoined: boolean;
  paid: boolean;
  peer?: TelegramPeer | undefined;
}
export interface JoinedChat {
  status: 'joined' | 'requested';
  peer?: TelegramPeer | undefined;
}
export interface ChatInvitesApi {
  checkChatInvite(hash: string): Effect.Effect<ChatInvitePreview, unknown>;
  joinChatInvite(hash: string): Effect.Effect<JoinedChat, unknown>;
}

export function chatInviteHash(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.port || url.hash) return undefined;
  let hash: string | undefined;
  if (
    url.protocol === 'tg:' &&
    url.hostname === 'join' &&
    (!url.pathname || url.pathname === '/')
  ) {
    if (
      [...url.searchParams.keys()].some((key) => key !== 'invite') ||
      url.searchParams.getAll('invite').length !== 1
    )
      return undefined;
    hash = url.searchParams.get('invite') ?? undefined;
  } else if (
    ['https:', 'http:'].includes(url.protocol) &&
    [
      't.me',
      'www.t.me',
      'telegram.me',
      'www.telegram.me',
      'telegram.dog',
      'www.telegram.dog',
    ].includes(url.hostname) &&
    !url.search
  ) {
    const match = /^\/(?:\+|joinchat\/)([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    hash = match?.[1];
  }
  return hash && /^[A-Za-z0-9_-]{1,256}$/.test(hash) ? hash : undefined;
}

export interface JoinRequestPerson {
  peer: TelegramPeer;
  title: string;
  initials: string;
  color: string;
  hasAvatar: boolean;
  avatarId?: string | undefined;
  date: number;
  about: string;
}
export interface JoinRequestOffset {
  date: number;
  user: TelegramPeer;
}
export interface JoinRequestsPage {
  people: JoinRequestPerson[];
  count: number;
  nextOffset?: JoinRequestOffset | undefined;
}
export interface JoinRequestsApi {
  getJoinRequests(
    peer: TelegramPeer,
    query?: string,
    offset?: JoinRequestOffset,
  ): Effect.Effect<JoinRequestsPage, unknown>;
  resolveJoinRequest(
    peer: TelegramPeer,
    user: TelegramPeer,
    approved: boolean,
  ): Effect.Effect<void, unknown>;
  resolveAllJoinRequests(peer: TelegramPeer, approved: boolean): Effect.Effect<void, unknown>;
}

export interface ChatInviteLink {
  url: string;
  title: string;
  adminId: string;
  date: number;
  permanent: boolean;
  revoked: boolean;
  requestNeeded: boolean;
  expireDate: number;
  usageLimit: number;
  usage: number;
  requested: number;
  paid: boolean;
}
export interface ChatInviteLinkDraft {
  title: string;
  requestNeeded: boolean;
  expireDate: number;
  usageLimit: number;
}
export interface ChatInviteLinksOffset {
  date: number;
  url: string;
}
export interface ChatInviteLinksPage {
  links: ChatInviteLink[];
  count: number;
  nextOffset?: ChatInviteLinksOffset | undefined;
}

export interface ChatManagementSettings {
  migratedFrom?: TelegramPeer | undefined;
  migratedTo?: TelegramPeer | undefined;
  grantableAdminRights?: ChatAdminRights;
  defaultRestrictions?: ChatRestrictions;
  title: string;
  about: string;
  username: string;
  broadcast: boolean;
  forum: boolean;
  slowModeSeconds: number;
  hiddenHistory: boolean;
  protectedContent: boolean;
  rights: {
    changeInfo: boolean;
    changeType: boolean;
    manageInvites: boolean;
    manageAdmins: boolean;
    restrictMembers: boolean;
    manageTopics: boolean;
    viewLog: boolean;
  };
}
export type ChatSettingChange =
  | { kind: 'title' | 'about' | 'username'; value: string }
  | { kind: 'forum' | 'hiddenHistory' | 'protectedContent'; value: boolean }
  | { kind: 'slowModeSeconds'; value: number }
  | { kind: 'defaultRestrictions'; value: ChatRestrictions };

export const adminRightKeys = [
  'changeInfo',
  'postMessages',
  'editMessages',
  'deleteMessages',
  'banUsers',
  'inviteUsers',
  'pinMessages',
  'addAdmins',
  'anonymous',
  'manageCall',
  'other',
  'manageTopics',
  'postStories',
  'editStories',
  'deleteStories',
  'manageDirectMessages',
  'manageRanks',
  'manageLinkedPeers',
] as const;
export type ChatAdminRights = Partial<Record<(typeof adminRightKeys)[number], boolean>>;
export const restrictionKeys = [
  'viewMessages',
  'sendMessages',
  'sendMedia',
  'sendStickers',
  'sendGifs',
  'sendGames',
  'sendInline',
  'embedLinks',
  'sendPolls',
  'changeInfo',
  'inviteUsers',
  'pinMessages',
  'manageTopics',
  'sendPhotos',
  'sendVideos',
  'sendRoundvideos',
  'sendAudios',
  'sendVoices',
  'sendDocs',
  'sendPlain',
  'editRank',
  'sendReactions',
  'manageLinkedPeers',
] as const;
export type ChatRestrictions = Partial<Record<(typeof restrictionKeys)[number], boolean>>;
export type ChatParticipantFilter = 'members' | 'admins' | 'restricted' | 'removed';
export interface ManagedParticipant {
  peer: TelegramPeer;
  title: string;
  initials: string;
  color: string;
  hasAvatar: boolean;
  avatarId?: string | undefined;
  role: 'owner' | 'admin' | 'member' | 'restricted' | 'removed';
  self: boolean;
  editable: boolean;
  rank: string;
  adminRights: ChatAdminRights;
  restrictions: ChatRestrictions;
  untilDate: number;
}
export interface ManagedParticipantsPage {
  people: ManagedParticipant[];
  count: number;
  nextOffset?: number | undefined;
}
export type ChatParticipantChange =
  | { kind: 'admin'; rights: ChatAdminRights; rank: string }
  | { kind: 'restrict'; restrictions: ChatRestrictions; untilDate: number }
  | { kind: 'remove' | 'unban' };
