import type { RichMessage } from '../domain/richMessage';
import type { Effect, Stream } from 'effect';
import type { MtprotoError } from './mtproto/errors';

export interface SyncCursor {
  pts: number;
  qts: number;
  date: number;
  seq: number;
}

export interface TelegramPeer {
  id: string;
  accessHash?: string | undefined;
  kind: 'user' | 'group' | 'channel';
}

export interface TelegramChatPermissions {
  canSendMessages: boolean;
  canSendMedia: boolean;
  canSendStickers: boolean;
  canSendPolls?: boolean | undefined;
  canSendGifs: boolean;
  canPinMessages: boolean;
  canEditMessages: boolean;
  canDeleteMessages: boolean;
  canDeleteForEveryone: boolean;
  canDeleteChat: boolean;
  canDeleteChannel: boolean;
  canLeave: boolean;
  canViewMembers: boolean;
  memberCount?: number | undefined;
}

export type TelegramDeleteDialogAction =
  | 'clear-for-me'
  | 'delete-for-everyone'
  | 'leave'
  | 'delete-chat'
  | 'delete-channel';

export interface TelegramDialog {
  peer: TelegramPeer;
  transient?: boolean | undefined;
  channelPts?: number | undefined;
  title: string;
  initials: string;
  color: string;
  username?: string | undefined;
  archived?: boolean | undefined;
  topMessageId: number;
  topMessage?: TelegramMessage | undefined;
  unreadCount: number;
  unreadMentionsCount?: number | undefined;
  unreadReactionsCount?: number | undefined;
  readInboxMaxId: number;
  readOutboxMaxId: number;
  muted: boolean;
  pinned: boolean;
  pinnedOrder?: number | undefined;
  permissions?: TelegramChatPermissions | undefined;
  bot?: boolean | undefined;
  hasAvatar: boolean;
  avatarId?: string | undefined;
  presence?: 'online' | 'recently' | 'offline' | undefined;
  lastSeenAt?: number | undefined;
  userDetails?: TelegramUserDetails | undefined;
}

export interface TelegramPeerSearchResult {
  peer: TelegramPeer;
  category: 'user' | 'bot' | 'group' | 'channel';
  title: string;
  initials: string;
  color: string;
  username?: string | undefined;
  bot: boolean;
  isContact: boolean;
  hasAvatar: boolean;
  avatarId?: string | undefined;
  permissions?: TelegramChatPermissions | undefined;
}

export interface TelegramUserDetails {
  botMenu?: { text: string; url: string } | undefined;
  botHasMainApp?: boolean | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  phone?: string | undefined;
  username?: string | undefined;
  bio?: string | undefined;
  birthday?: { day: number; month: number; year?: number | undefined } | undefined;
  isContact?: boolean | undefined;
  blocked: boolean;
}

export interface TelegramGroupMember {
  firstName?: string | undefined;
  isSelf?: boolean | undefined;
  peer: TelegramPeer;
  title: string;
  initials: string;
  color: string;
  username?: string | undefined;
  role?: string | undefined;
  roleKind?: 'owner' | 'admin' | undefined;
  hasAvatar: boolean;
  avatarId?: string | undefined;
  presence?: 'online' | 'recently' | 'offline' | undefined;
}

export interface TelegramGroupMemberPage {
  members: TelegramGroupMember[];
  totalCount: number;
  hasMore: boolean;
  nextOffset?: number | undefined;
}

export interface TelegramDiscussion {
  peer: TelegramPeer;
  root: TelegramMessage;
  unreadCount: number;
}

export interface TelegramPollDraft {
  question: string;
  answers: readonly string[];
  publicVoters: boolean;
  multipleChoice: boolean;
  quiz: boolean;
  correctAnswer?: number | undefined;
  solution: string;
}
export interface TelegramPollResults {
  min?: boolean | undefined;
  totalVoters?: number | undefined;
  solution?: string | undefined;
  answers?:
    | readonly {
        option: string;
        voters: number;
        chosen?: boolean | undefined;
        correct?: boolean | undefined;
      }[]
    | undefined;
}
export interface TelegramPoll {
  id: string;
  hash: string;
  question: string;
  answers: readonly { option: string; text: string }[];
  closed: boolean;
  publicVoters: boolean;
  multipleChoice: boolean;
  quiz: boolean;
  revotingDisabled: boolean;
  hideResultsUntilClose: boolean;
  closeDate?: number | undefined;
  results: TelegramPollResults;
}
export type TelegramPollAction = 'vote' | 'refresh' | 'close';

export interface TelegramContact {
  phoneNumber: string;
  firstName: string;
  lastName: string;
  vcard: string;
  peer?: TelegramPeer | undefined;
  hasAvatar?: boolean | undefined;
  avatarId?: string | undefined;
}

export interface TelegramMessage {
  id: number;
  peerId: string;
  peer?: TelegramPeer | undefined;
  peerTitle?: string | undefined;
  permissions?: TelegramChatPermissions | undefined;
  senderId: string;
  senderName?: string | undefined;
  senderHasAvatar?: boolean | undefined;
  senderAvatarId?: string | undefined;
  senderColor?: string | undefined;
  senderColorVersion?: number | undefined;
  senderRole?: string | undefined;
  senderRoleKind?: 'owner' | 'admin' | undefined;
  text: string;
  date: number;
  outgoing: boolean;
  mediaUnread?: boolean | undefined;
  unreadMention?: boolean | undefined;
  unreadReaction?: boolean | undefined;
  protected?: boolean | undefined;
  editedAt?: number | undefined;
  replyToId?: number | undefined;
  replyQuote?: string | undefined;
  comments?: { count: number; channelId: string } | undefined;
  randomId?: string | undefined;
  groupedId?: string | undefined;
  forwardedFrom?: TelegramForwardedFrom | undefined;
  service?: TelegramServiceMessage | undefined;
  contact?: TelegramContact | undefined;
  poll?: TelegramPoll | undefined;
  botKeyboard?: TelegramBotKeyboard | undefined;
  media?: TelegramMedia | undefined;
  reactions?: readonly TelegramReaction[] | undefined;
  mentions?: readonly TelegramMention[] | undefined;
  links?: readonly TelegramLink[] | undefined;
  linkPreview?: TelegramLinkPreview | undefined;
  formats?: readonly TelegramTextFormat[] | undefined;
  richMessage?: RichMessage | undefined;
  pinned?: boolean | undefined;
}

export interface TelegramForwardedFrom {
  name: string;
  peerId?: string | undefined;
  messageId?: number | undefined;
  hasAvatar?: boolean | undefined;
  avatarId?: string | undefined;
  color?: string | undefined;
}

export interface TelegramWebAppRequest {
  peer: TelegramPeer;
  bot: TelegramPeer;
  mode: 'simple' | 'inline' | 'menu' | 'main' | 'app';
  app?: { id: string; accessHash: string } | undefined;
  writeAllowed?: boolean | undefined;
  displayMode?: 'compact' | 'fullscreen' | undefined;
  url?: string | undefined;
  startParam?: string | undefined;
  theme: Readonly<Record<string, string>>;
}
export interface TelegramBotAppInfo {
  id: string;
  accessHash: string;
  title: string;
  description: string;
  requestWriteAccess: boolean;
}
export interface TelegramWebApp {
  url: string;
  queryId?: string | undefined;
  fullsize: boolean;
  fullscreen: boolean;
}

export interface TelegramBotCommand {
  command: string;
  description: string;
  botId?: string | undefined;
  botUsername?: string | undefined;
  botName?: string | undefined;
}

export type TelegramBotButtonKind =
  | 'text'
  | 'url'
  | 'url-auth'
  | 'callback'
  | 'copy'
  | 'switch-inline'
  | 'web-app'
  | 'simple-web-app'
  | 'unsupported';

export interface TelegramBotButton {
  kind: TelegramBotButtonKind;
  text: string;
  url?: string | undefined;
  buttonId?: number | undefined;
  data?: readonly number[] | undefined;
  copyText?: string | undefined;
  query?: string | undefined;
  samePeer?: boolean | undefined;
  botUsername?: string | undefined;
  bot?: TelegramPeer | undefined;
}

export interface TelegramBotKeyboard {
  kind: 'inline' | 'reply';
  rows: readonly (readonly TelegramBotButton[])[];
  hidden?: boolean | undefined;
  forceReply?: boolean | undefined;
  singleUse?: boolean | undefined;
  persistent?: boolean | undefined;
  placeholder?: string | undefined;
}

export interface TelegramBotCallbackResult {
  message?: string | undefined;
  alert?: boolean | undefined;
  url?: string | undefined;
}

export type TelegramUrlAuthResult =
  | { kind: 'default' }
  | { kind: 'accepted'; url?: string | undefined }
  | {
      kind: 'request';
      botTitle: string;
      domain: string;
      requestWriteAccess: boolean;
      requestPhoneNumber: boolean;
      matchCodesFirst: boolean;
      isApp: boolean;
      matchCodes?: readonly string[] | undefined;
      verifiedAppName?: string | undefined;
    };

export interface TelegramUrlAuthAcceptOptions {
  writeAllowed?: boolean | undefined;
  sharePhoneNumber?: boolean | undefined;
  matchCode?: string | undefined;
}

export type TelegramServiceMessageKind =
  | 'chat-created'
  | 'title-changed'
  | 'photo-changed'
  | 'photo-removed'
  | 'users-added'
  | 'user-removed'
  | 'joined-by-link'
  | 'joined-by-request'
  | 'message-pinned'
  | 'history-cleared'
  | 'auto-delete-changed'
  | 'topic-created'
  | 'topic-changed'
  | 'screenshot-taken'
  | 'custom'
  | 'other';

export interface TelegramServiceMessage {
  kind: TelegramServiceMessageKind;
  text: string;
  actorId?: string | undefined;
  targetUserIds?: readonly string[] | undefined;
  title?: string | undefined;
}

export interface TelegramMention {
  offset: number;
  length: number;
  userId?: string | undefined;
}

export interface TelegramLink {
  offset: number;
  length: number;
  url?: string | undefined;
}

export interface TelegramLinkPreview {
  url: string;
  webPageId?: string | undefined;
  type?: string | undefined;
  hasEmbed?: boolean | undefined;
  siteName?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  hasPhoto?: boolean | undefined;
  photoSize?: 'small' | 'large' | undefined;
  media?: (TelegramMedia & { kind: 'video' | 'animation' }) | undefined;
}

export interface TelegramTextFormat {
  offset: number;
  length: number;
  kind:
    | 'bold'
    | 'italic'
    | 'underline'
    | 'strike'
    | 'code'
    | 'pre'
    | 'spoiler'
    | 'blockquote'
    | 'expandableBlockquote'
    | 'mention'
    | 'mentionName'
    | 'textUrl'
    | 'customEmoji'
    | 'formattedDate'
    | 'diffInsert'
    | 'diffReplace'
    | 'diffDelete';
  url?: string | undefined;
  userId?: string | undefined;
  accessHash?: string | undefined;
  customEmojiId?: string | undefined;
  timestamp?: number | undefined;
  oldText?: string | undefined;
}

export interface TelegramSearchFilters {
  kind?: SharedMediaKind | undefined;
  fromPeer?: TelegramPeer | undefined;
  minDate?: number | undefined;
  maxDate?: number | undefined;
  chatType?: 'users' | 'groups' | 'channels' | undefined;
}

export interface TelegramSearchPage {
  messages: TelegramMessage[];
  hasMore: boolean;
  nextOffset?: TelegramSearchOffset | undefined;
  channelPts?: number | undefined;
}

export interface TelegramSearchOffset {
  messageId: number;
  peer?: TelegramPeer | undefined;
  rate?: number | undefined;
}

export type SharedMediaKind = 'photos' | 'videos' | 'files' | 'audio' | 'links' | 'voice' | 'gifs';
export type TelegramResourceKind =
  | 'expressions'
  | 'web-app-result'
  | 'bot-commands'
  | 'group-members'
  | 'peer-metadata';
export interface TelegramResourceInvalidation {
  kind: TelegramResourceKind;
  queryId?: string | undefined;
  peerId?: string | undefined;
}
export type TelegramConversationEvent =
  | { type: 'message-upsert'; message: TelegramMessage; insertIfMissing?: boolean }
  | { type: 'messages-delete'; peerId?: string | undefined; messageIds: number[] }
  | { type: 'pinned-messages'; peerId: string; messages: TelegramMessage[] }
  | { type: 'history-reset'; peerId?: string | undefined };
export type TelegramActivityKind = 'typing' | 'uploading' | 'recording' | 'choosing-sticker';

export interface TelegramActivity {
  peerId: string;
  senderId: string;
  kind: TelegramActivityKind;
}

export interface TelegramReplyTarget {
  messageId: number;
  quoteText?: string | undefined;
}

export interface TelegramDraftDetails {
  formats: readonly TelegramTextFormat[];
  reply?: TelegramReplyTarget & { preview: string };
}

export interface TelegramReactionPerson {
  id: string;
  peer: TelegramPeer;
  name: string;
  initials: string;
  color: string;
  hasAvatar: boolean;
  avatarId?: string | undefined;
}

export type TelegramPrivacyKey =
  | 'phone-number'
  | 'added-by-phone'
  | 'last-seen'
  | 'profile-photo'
  | 'about'
  | 'birthday'
  | 'forwards'
  | 'calls'
  | 'p2p'
  | 'invites'
  | 'voice-messages'
  | 'saved-music';
export type TelegramPrivacyAudience = 'everyone' | 'contacts' | 'nobody';
export type TelegramPrivacyRule =
  | {
      kind:
        | 'allow-all'
        | 'deny-all'
        | 'allow-contacts'
        | 'deny-contacts'
        | 'allow-premium'
        | 'allow-bots'
        | 'deny-bots'
        | 'allow-close-friends'
        | 'unsupported';
    }
  | { kind: 'allow-users' | 'deny-users'; users: readonly TelegramPeer[] }
  | { kind: 'allow-chats' | 'deny-chats'; chats: readonly string[] };
export interface TelegramPrivacySetting {
  key: TelegramPrivacyKey;
  rules: readonly TelegramPrivacyRule[];
  peers: TelegramPeerSearchResult[];
}
export interface TelegramPrivacyChange {
  audience?: TelegramPrivacyAudience | undefined;
  exceptions?:
    | readonly { peer: TelegramPeer; allow: boolean; remove?: boolean | undefined }[]
    | undefined;
}

export interface TelegramActiveSession {
  id: string;
  current: boolean;
  device: string;
  platform: string;
  systemVersion: string;
  appName: string;
  appVersion: string;
  createdAt: number;
  activeAt: number;
  ip: string;
  country: string;
  region: string;
  passwordPending: boolean;
  unconfirmed: boolean;
}
export interface TelegramActiveSessions {
  sessions: TelegramActiveSession[];
  ttlDays: number;
}

export interface TelegramPollVoter extends TelegramReactionPerson {
  options: string[];
  date: number;
}
export interface TelegramPollVotes {
  unavailable?: 'broadcast' | 'vote-required' | 'deleted' | undefined;
  people: TelegramPollVoter[];
  count: number;
  nextOffset?: string | undefined;
}
export interface TelegramReadParticipant extends TelegramReactionPerson {
  readAt: number;
}
export interface TelegramReadReceipts {
  state:
    | 'available'
    | 'unread'
    | 'expired'
    | 'privacy'
    | 'own-privacy'
    | 'too-large'
    | 'unavailable';
  people: TelegramReadParticipant[];
}

export interface TelegramReactionPeople {
  people: TelegramReactionPerson[];
  count: number;
  anonymous?: boolean | undefined;
}

export interface TelegramReaction {
  emoji: string;
  customEmojiId?: string | undefined;
  count: number;
  chosen: boolean;
}

export interface TelegramSticker {
  id: string;
  accessHash: string;
  fileReference: Uint8Array;
  emoji: string;
  mimeType: string;
  dcId?: number | undefined;
  size?: number | undefined;
  title?: string | undefined;
  inlineQueryId?: string | undefined;
  inlineResultId?: string | undefined;
}

export interface TelegramStickerSearchPage {
  stickers: TelegramSticker[];
  nextOffset?: number | undefined;
}

export interface TelegramStickerPack {
  id: string;
  accessHash?: string | undefined;
  shortName?: string | undefined;
  installed?: boolean | undefined;
  count?: number | undefined;
  title: string;
  stickers: TelegramSticker[];
}

export interface TelegramMedia {
  kind: 'photo' | 'video' | 'round-video' | 'voice' | 'animation' | 'sticker' | 'file';
  name: string;
  mimeType: string;
  size?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  duration?: number | undefined;
  waveform?: readonly number[] | undefined;
  cacheKey?: string | undefined;
  spoiler?: boolean | undefined;
}

export type TelegramTransferProgress = ((progress: number) => void) & { isCanceled?: boolean };

export type TelegramTransportProgress = (progress: number) => Effect.Effect<void>;

export interface TelegramDownloadOptions {
  progress?: TelegramTransferProgress | undefined;
  preview?: boolean | undefined;
  /** Inclusive byte range of the original media, for browser playback. */
  range?: { start: number; end: number } | undefined;
}

export type TransportUpdate =
  | {
      type: 'read-message-contents';
      expectedReactionVersion?: number | undefined;
      peerId?: string | undefined;
      messageIds: number[];
      pts: number;
      ptsCount: number;
      channelScoped?: boolean | undefined;
    }
  | { type: 'message-id-assigned'; messageId: number; randomId: string }
  | {
      type: 'new-message';
      pts: number;
      ptsCount: number;
      channelScoped?: boolean | undefined;
      message: TelegramMessage;
    }
  | {
      type: 'edit-message';
      pts: number;
      ptsCount: number;
      channelScoped?: boolean | undefined;
      message: TelegramMessage;
    }
  | {
      type: 'web-page-updated';
      pts: number;
      ptsCount: number;
      channelScoped?: boolean | undefined;
      peerId?: string | undefined;
      webPageId: string;
      linkPreview: TelegramLinkPreview;
    }
  | {
      type: 'delete-messages';
      pts: number;
      ptsCount: number;
      channelScoped?: boolean | undefined;
      peerId?: string | undefined;
      messageIds: number[];
    }
  | {
      type: 'read-history';
      pts: number;
      ptsCount: number;
      channelScoped?: boolean | undefined;
      peerId: string;
      maxMessageId: number;
      direction: 'inbox' | 'outbox';
      stillUnreadCount?: number | undefined;
    }
  | {
      type: 'poll-changed';
      pollId: string;
      peerId?: string | undefined;
      messageId?: number | undefined;
      poll?: TelegramPoll | undefined;
      results: TelegramPollResults;
    }
  | { type: 'dialog-changed'; dialog: TelegramDialog }
  | {
      type: 'reaction-changed';
      unreadReaction?: boolean | undefined;
      peerId: string;
      messageId: number;
      reactions: readonly TelegramReaction[];
    }
  | { type: 'activity'; activity: TelegramActivity }
  | { type: 'activity-ended'; peerId: string; senderId: string }
  | {
      type: 'presence-changed';
      peerId: string;
      presence: 'online' | 'recently' | 'offline';
      lastSeenAt?: number | undefined;
    }
  | { type: 'mute-changed'; peerId: string; muted: boolean }
  | { type: 'dialog-pinned'; peerId: string; pinned: boolean }
  | { type: 'expression-index-changed'; kind: 'stickers' | 'gifs' | 'all' }
  | {
      type: 'pinned-messages';
      pts: number;
      ptsCount: number;
      channelScoped?: boolean | undefined;
      peerId: string;
      messageIds: number[];
      pinned: boolean;
    }
  | {
      type: 'dialog-folders-changed';
      pts: number;
      ptsCount: number;
      folders: { peerId: string; folderId: number }[];
    }
  | { type: 'web-app-result'; queryId: string }
  | { type: 'bot-commands-changed'; peerId: string; botId?: string | undefined }
  | { type: 'pts-advanced'; pts: number; ptsCount: number; channelScoped?: boolean | undefined }
  | { type: 'dialog-list-invalidated' }
  | { type: 'peer-metadata-changed'; peerId: string }
  | { type: 'channel-too-long'; peerId: string }
  | { type: 'connection-state'; connected: boolean }
  | { type: 'too-long' };

export interface TransportUpdateBatch {
  updates: TransportUpdate[];
  date?: number | undefined;
  seq?: number | undefined;
  seqStart?: number | undefined;
}

export type DifferenceResult =
  | { type: 'complete'; cursor: SyncCursor; updates: TransportUpdate[] }
  | { type: 'too-long'; cursor: SyncCursor };

export type ChannelDifferenceResult =
  | { type: 'complete'; pts: number; updates: TransportUpdate[] }
  | { type: 'too-long'; pts: number };

export interface DialogPage {
  dialogs: TelegramDialog[];
  nextOffset?: string;
}

export interface HistoryPage {
  messages: TelegramMessage[];
  hasOlder: boolean;
  nextBeforeMessageId?: number | undefined;
  channelPts?: number | undefined;
}

export interface HistoryAroundPage {
  messages: TelegramMessage[];
  channelPts?: number | undefined;
}

export interface SharedMediaCounts {
  photos: number;
  videos: number;
  files: number;
  audio: number;
  links: number;
  voice: number;
  gifs: number;
}

export interface TransportMutationResult {
  updateBatches?: TransportUpdateBatch[] | undefined;
}

export interface SendTextResult extends TransportMutationResult {
  message: TelegramMessage;
}

export interface SendAlbumResult extends TransportMutationResult {
  messages: TelegramMessage[];
}

export interface EditMessageResult extends TransportMutationResult {
  message: TelegramMessage;
}

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export type TelegramBaseTheme = 'classic' | 'day' | 'night' | 'tinted' | 'arctic';

export interface TelegramWallpaperSettings {
  backgroundColors: readonly string[];
  blur: boolean;
  motion: boolean;
  intensity?: number | undefined;
  rotation?: number | undefined;
  emoticon?: string | undefined;
}

export interface TelegramWallpaper {
  id: string;
  slug?: string | undefined;
  dark: boolean;
  pattern: boolean;
  hasFile: boolean;
  settings: TelegramWallpaperSettings;
}

export interface TelegramThemeSettings {
  baseTheme: TelegramBaseTheme;
  accentColor: string;
  outboxAccentColor?: string | undefined;
  messageColors: readonly string[];
  messageColorsAnimated: boolean;
  wallpaper?: TelegramWallpaper | undefined;
}

export interface TelegramTheme {
  id: string;
  slug: string;
  title: string;
  emoticon?: string | undefined;
  default: boolean;
  forChat: boolean;
  settings: readonly TelegramThemeSettings[];
}

export interface TelegramChatAppearance {
  theme?: TelegramTheme | undefined;
  wallpaper?: TelegramWallpaper | undefined;
}

export type TelegramTransportError = MtprotoError;
type TransportEffect<Value> = Effect.Effect<Value, TelegramTransportError>;

export type TelegramQrLogin =
  | { type: 'token'; url: string; expires: number }
  | { type: 'authorized' }
  | { type: 'password-required' };

export interface TelegramTransport {
  watchQrLogin?(): Stream.Stream<TelegramQrLogin, TelegramTransportError>;
  connect(credentials: TelegramCredentials): TransportEffect<void>;
  disconnect(): TransportEffect<void>;
  logOut(): TransportEffect<void>;
  isAuthorized(): TransportEffect<boolean>;
  getAuthorizedAccountId(): TransportEffect<string>;
  requestCode(phoneNumber: string): TransportEffect<{ isCodeViaApp: boolean }>;
  submitCode(
    code: string,
  ): TransportEffect<'authorized' | 'password-required' | 'sign-up-required'>;
  submitPassword(password: string): TransportEffect<void>;
  getCurrentState(): TransportEffect<SyncCursor>;
  getDifference(cursor: SyncCursor, totalLimit: number): TransportEffect<DifferenceResult>;
  getChannelDifference(
    peer: TelegramPeer,
    pts: number,
    totalLimit: number,
  ): TransportEffect<ChannelDifferenceResult>;
  getDialogs(limit: number): TransportEffect<DialogPage>;
  getDialog?(peer: TelegramPeer): TransportEffect<TelegramDialog | undefined>;
  resolveUsername?(username: string): TransportEffect<TelegramPeerSearchResult | undefined>;
  getDiscussion?(
    peer: TelegramPeer,
    messageId: number,
  ): TransportEffect<TelegramDiscussion | undefined>;
  getReplies?(
    peer: TelegramPeer,
    rootId: number,
    limit: number,
    beforeMessageId?: number,
  ): TransportEffect<HistoryPage>;
  searchPeers(query: string, limit?: number): TransportEffect<TelegramPeerSearchResult[]>;
  getHistory(
    peer: TelegramPeer,
    limit: number,
    beforeMessageId?: number,
  ): TransportEffect<HistoryPage>;
  getHistoryAround?(
    peer: TelegramPeer,
    messageId: number,
    limit: number,
  ): TransportEffect<HistoryAroundPage>;
  getUnreadNotifications?(
    peer: TelegramPeer,
    kind: 'mention' | 'reaction',
  ): TransportEffect<{ messages: TelegramMessage[]; count: number }>;
  readAllNotifications?(
    peer: TelegramPeer,
    kind: 'mention' | 'reaction',
  ): TransportEffect<TransportMutationResult>;
  readHistory(peer: TelegramPeer, maxMessageId: number): TransportEffect<TransportMutationResult>;
  readMessageContents(
    peer: TelegramPeer,
    messageIds: number[],
  ): TransportEffect<TransportMutationResult>;
  getReadOutboxMaxId?(peer: TelegramPeer): TransportEffect<number>;
  getSharedMediaCounts(peer: TelegramPeer): TransportEffect<SharedMediaCounts>;
  getSharedMedia(
    peer: TelegramPeer,
    kind: SharedMediaKind,
    limit: number,
    offset?: TelegramSearchOffset,
  ): TransportEffect<TelegramSearchPage>;
  searchMessages(
    query: string,
    peer?: TelegramPeer,
    limit?: number,
    offset?: TelegramSearchOffset,
    filters?: TelegramSearchFilters,
  ): TransportEffect<TelegramSearchPage>;
  getPinnedMessages(peer: TelegramPeer): TransportEffect<TelegramMessage[]>;
  getUserDetails(peer: TelegramPeer): TransportEffect<TelegramUserDetails>;
  updateContact?(
    peer: TelegramPeer,
    firstName: string,
    lastName: string,
    phone: string,
  ): TransportEffect<void>;
  deleteContact?(peer: TelegramPeer): TransportEffect<void>;
  getGroupMembers?(
    peer: TelegramPeer,
    limit?: number,
    offset?: number,
    query?: string,
  ): TransportEffect<TelegramGroupMemberPage>;
  setMuted(peer: TelegramPeer, muted: boolean): TransportEffect<void>;
  setBlocked(peer: TelegramPeer, blocked: boolean): TransportEffect<void>;
  setPinnedDialog(peer: TelegramPeer, pinned: boolean): TransportEffect<void>;
  setArchived(peer: TelegramPeer, archived: boolean): TransportEffect<TransportMutationResult>;
  deleteDialog(
    peer: TelegramPeer,
    action?: TelegramDeleteDialogAction,
  ): TransportEffect<TransportMutationResult>;
  setPinnedMessage(
    peer: TelegramPeer,
    messageId: number,
    pinned: boolean,
  ): TransportEffect<TransportMutationResult>;
  setTyping(peer: TelegramPeer, kind?: TelegramActivityKind): TransportEffect<void>;
  updatePoll?(
    peer: TelegramPeer,
    messageId: number,
    poll: TelegramPoll,
    action: TelegramPollAction,
    options: readonly string[],
  ): TransportEffect<TransportMutationResult>;
  sendPoll?(
    peer: TelegramPeer,
    draft: TelegramPollDraft,
    randomId: string,
  ): TransportEffect<SendTextResult>;
  sendContact?(
    peer: TelegramPeer,
    contact: TelegramContact,
    randomId: string,
  ): TransportEffect<SendTextResult>;
  sendText(
    peer: TelegramPeer,
    text: string,
    randomId: string,
    reply?: TelegramReplyTarget,
    formats?: readonly TelegramTextFormat[],
  ): TransportEffect<SendTextResult>;
  sendFile(
    peer: TelegramPeer,
    file: File,
    options: SendFileOptions,
  ): TransportEffect<SendTextResult>;
  sendAlbum(
    peer: TelegramPeer,
    attachments: SendAlbumAttachment[],
    options: SendAlbumOptions,
  ): TransportEffect<SendAlbumResult>;
  downloadMedia(message: TelegramMessage, options?: TelegramDownloadOptions): TransportEffect<Blob>;
  downloadAvatar(peer: TelegramPeer): TransportEffect<Blob | undefined>;
  getThemes?(): TransportEffect<TelegramTheme[]>;
  getWallpapers?(): TransportEffect<TelegramWallpaper[]>;
  getChatAppearance?(peer: TelegramPeer): TransportEffect<TelegramChatAppearance | undefined>;
  downloadWallpaper?(wallpaperId: string): TransportEffect<Blob>;
  searchStickers?(query: string, offset?: number): TransportEffect<TelegramStickerSearchPage>;
  getRecentStickers(): TransportEffect<TelegramSticker[]>;
  getFavoriteStickers?(): TransportEffect<TelegramSticker[]>;
  setStickerFavorite?(sticker: TelegramSticker, favorite: boolean): TransportEffect<boolean>;
  getStickerPacks(): TransportEffect<TelegramStickerPack[]>;
  getStickerPack?(shortName: string): TransportEffect<TelegramStickerPack>;
  searchStickerPacks?(query: string): TransportEffect<TelegramStickerPack[]>;
  setStickerPackInstalled?(pack: TelegramStickerPack, installed: boolean): TransportEffect<boolean>;
  getSavedGifs(): TransportEffect<TelegramSticker[]>;
  searchGifs?(peer: TelegramPeer, query: string): TransportEffect<TelegramSticker[]>;
  downloadSticker(sticker: TelegramSticker): TransportEffect<Blob>;
  downloadCustomEmoji?(documentId: string): TransportEffect<Blob>;
  getBotApp?(bot: TelegramPeer, shortName: string): TransportEffect<TelegramBotAppInfo>;
  requestWebApp?(request: TelegramWebAppRequest): TransportEffect<TelegramWebApp>;
  prolongWebApp?(peer: TelegramPeer, bot: TelegramPeer, queryId: string): TransportEffect<void>;
  sendWebAppData?(
    bot: TelegramPeer,
    buttonText: string,
    data: string,
    randomId: string,
  ): TransportEffect<void>;
  invokeWebAppMethod?(bot: TelegramPeer, method: string, params: string): TransportEffect<string>;
  getBotCommands?(peer: TelegramPeer): TransportEffect<TelegramBotCommand[]>;
  startBot?(
    peer: TelegramPeer,
    startParam: string,
    randomId: string,
  ): TransportEffect<SendTextResult>;
  answerBotCallback?(
    peer: TelegramPeer,
    messageId: number,
    data: number[],
  ): TransportEffect<TelegramBotCallbackResult>;
  requestUrlAuth?(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
  ): TransportEffect<TelegramUrlAuthResult>;
  acceptUrlAuth?(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
    acceptOptions?: TelegramUrlAuthAcceptOptions,
  ): TransportEffect<TelegramUrlAuthResult>;
  sendSticker(
    peer: TelegramPeer,
    sticker: TelegramSticker,
    randomId: string,
    reply?: TelegramReplyTarget,
  ): TransportEffect<SendTextResult>;
  getPrivacy?(key: TelegramPrivacyKey): TransportEffect<TelegramPrivacySetting>;
  setPrivacy?(
    key: TelegramPrivacyKey,
    change: TelegramPrivacyChange,
  ): TransportEffect<TelegramPrivacySetting>;
  getReadTimePrivacy?(): TransportEffect<boolean>;
  setReadTimePrivacy?(hidden: boolean): TransportEffect<boolean>;
  getActiveSessions?(): TransportEffect<TelegramActiveSessions>;
  terminateSession?(hash?: string): TransportEffect<void>;
  setSessionTtl?(days: number): TransportEffect<void>;
  getPollVotes?(
    peer: TelegramPeer,
    messageId: number,
    option?: string,
    offset?: string,
  ): TransportEffect<TelegramPollVotes>;
  getMessageReadReceipts?(
    peer: TelegramPeer,
    messageId: number,
  ): TransportEffect<TelegramReadReceipts>;
  getReactionPeople?(
    peer: TelegramPeer,
    messageId: number,
    emoji: string,
  ): TransportEffect<TelegramReactionPeople>;
  setReaction(
    peer: TelegramPeer,
    messageId: number,
    emoji?: string,
  ): TransportEffect<TransportMutationResult>;
  deleteMessages(
    peer: TelegramPeer,
    messageIds: number[],
    revoke: boolean,
  ): TransportEffect<TransportMutationResult>;
  editMessage(
    peer: TelegramPeer,
    messageId: number,
    text: string,
    formats?: readonly TelegramTextFormat[],
    replacement?: EditMediaOptions,
  ): TransportEffect<EditMessageResult>;
  forwardMessage(
    fromPeer: TelegramPeer,
    toPeer: TelegramPeer,
    messageId: number,
    randomId: string,
    options?: TelegramForwardOptions,
  ): TransportEffect<SendTextResult>;
  readonly updates: Stream.Stream<TransportUpdateBatch, TelegramTransportError>;
}

export type OutgoingAttachmentMode = 'media' | 'file';

export interface SendFileOptions {
  caption: string;
  randomId: string;
  asSticker: boolean;
  sendAs: OutgoingAttachmentMode;
  reply?: TelegramReplyTarget | undefined;
  formats?: readonly TelegramTextFormat[] | undefined;
  onProgress?: TelegramTransportProgress | undefined;
}

export interface SendAlbumAttachment {
  file: File;
  randomId: string;
  sendAs: 'media';
}

export interface SendAlbumOptions {
  caption: string;
  reply?: TelegramReplyTarget | undefined;
  formats?: readonly TelegramTextFormat[] | undefined;
  onProgress?: TelegramTransportProgress | undefined;
}

export type EditMediaOptions = OutgoingAttachment;

export interface LocalMediaMetadata {
  width?: number | undefined;
  height?: number | undefined;
  duration?: number | undefined;
  preview?: Blob | undefined;
}

export interface OutgoingAttachment extends LocalMediaMetadata {
  file: File;
  sendAs: OutgoingAttachmentMode;
}

export interface PendingAttachment extends LocalMediaMetadata {
  blob: Blob;
  name: string;
  mimeType: string;
  asSticker: boolean;
  sendAs: OutgoingAttachmentMode;
}

export interface PendingAlbumAttachment extends PendingAttachment {
  randomId: string;
  sendAs: 'media';
}

export interface TelegramForwardOptions {
  hideAuthor?: boolean | undefined;
  hideCaption?: boolean | undefined;
}

export interface PendingSend {
  id: string;
  accountId?: string | undefined;
  peer: TelegramPeer;
  text: string;
  randomId: string;
  createdAt: number;
  queueOrder?: number | undefined;
  attempts: number;
  lastError?: string | undefined;
  uploadProgress?: number | undefined;
  reply?: TelegramReplyTarget | undefined;
  formats?: readonly TelegramTextFormat[] | undefined;
  sticker?: TelegramSticker | undefined;
  contact?: TelegramContact | undefined;
  pollDraft?: TelegramPollDraft | undefined;
  forward?:
    | {
        fromPeer: TelegramPeer;
        messageId: number;
        mediaKind?: TelegramMedia['kind'] | undefined;
        options?: TelegramForwardOptions | undefined;
      }
    | undefined;
  botStart?: { startParam: string } | undefined;
  attachment?: PendingAttachment | undefined;
  album?: { attachments: readonly PendingAlbumAttachment[] } | undefined;
}

export interface CachedDialog extends TelegramDialog {
  cacheEpoch: number;
}

export interface CachedMessage extends TelegramMessage {
  cacheEpoch: number;
}

export interface TelegramHistoryGap {
  olderMaxMessageId: number;
  newerMinMessageId: number;
}

export type AccountSnapshot = {
  phase: 'idle' | 'connecting' | 'unauthorized' | 'syncing' | 'ready' | 'error';
  sync: 'current' | 'recovering' | 'stale';
  online: boolean;
  dialogs: TelegramDialog[];
  drafts: Record<string, string>;
  draftDetails: Record<string, TelegramDraftDetails>;
  pending: PendingSend[];
  activities: TelegramActivity[];
  authStep?: 'phone' | 'code' | 'password' | 'qr' | undefined;
  qrLogin?: { url: string; expires: number } | undefined;
  codeViaApp?: boolean | undefined;
  operationError?: string | undefined;
  error?: string | undefined;
  requiresReload?: boolean | undefined;
};

export type ConversationViewSnapshot = {
  activePeerId?: string | undefined;
  messages: TelegramMessage[];
  loadingMessages: boolean;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  sharedMediaCounts?: SharedMediaCounts | undefined;
  pinnedMessages: TelegramMessage[];
  historyGaps: TelegramHistoryGap[];
  historyError?: string | undefined;
  historyRetryAt?: number | undefined;
};

export interface EngineSnapshot extends AccountSnapshot, ConversationViewSnapshot {}
