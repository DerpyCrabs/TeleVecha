import type { RichMessage } from '../domain/richMessage';

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
  readInboxMaxId: number;
  readOutboxMaxId: number;
  muted: boolean;
  pinned: boolean;
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
}

export interface TelegramUserDetails {
  firstName?: string | undefined;
  lastName?: string | undefined;
  phone?: string | undefined;
  username?: string | undefined;
  bio?: string | undefined;
  birthday?:
    | {
        day: number;
        month: number;
        year?: number | undefined;
      }
    | undefined;
  isContact?: boolean | undefined;
  blocked: boolean;
}

export interface TelegramGroupMember {
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

export interface TelegramMessage {
  id: number;
  peerId: string;
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
  editedAt?: number | undefined;
  replyToId?: number | undefined;
  replyQuote?: string | undefined;
  randomId?: string | undefined;
  groupedId?: string | undefined;
  forwardedFrom?: TelegramForwardedFrom | undefined;
  service?: TelegramServiceMessage | undefined;
  botKeyboard?: TelegramBotKeyboard | undefined;
  media?: TelegramMedia | undefined;
  reactions?: TelegramReaction[] | undefined;
  mentions?: TelegramMention[] | undefined;
  links?: TelegramLink[] | undefined;
  linkPreview?: TelegramLinkPreview | undefined;
  formats?: TelegramTextFormat[] | undefined;
  richMessage?: RichMessage | undefined;
  pinned?: boolean | undefined;
}

export interface TelegramForwardedFrom {
  name: string;
  peerId?: string | undefined;
  messageId?: number | undefined;
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
  | 'unsupported';

export interface TelegramBotButton {
  kind: TelegramBotButtonKind;
  text: string;
  url?: string | undefined;
  buttonId?: number | undefined;
  data?: number[] | undefined;
  copyText?: string | undefined;
  query?: string | undefined;
  samePeer?: boolean | undefined;
  botUsername?: string | undefined;
}

export interface TelegramBotKeyboard {
  kind: 'inline' | 'reply';
  rows: TelegramBotButton[][];
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
      matchCodes?: string[] | undefined;
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
  targetUserIds?: string[] | undefined;
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
  siteName?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  hasPhoto?: boolean | undefined;
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
    | 'textUrl'
    | 'customEmoji'
    | 'formattedDate'
    | 'diffInsert'
    | 'diffReplace'
    | 'diffDelete';
  url?: string | undefined;
  customEmojiId?: string | undefined;
  timestamp?: number | undefined;
  oldText?: string | undefined;
}

export interface TelegramSearchPage {
  messages: TelegramMessage[];
  hasMore: boolean;
  nextOffset?: TelegramSearchOffset | undefined;
}

export interface TelegramSearchOffset {
  messageId: number;
  peer?: TelegramPeer | undefined;
  rate?: number | undefined;
}

export type SharedMediaKind = 'photos' | 'videos' | 'files' | 'audio' | 'links' | 'voice' | 'gifs';
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

export interface TelegramStickerPack {
  id: string;
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
  cacheKey?: string | undefined;
}

export type TransportUpdate =
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
      type: 'dialog-changed';
      dialog: TelegramDialog;
    }
  | {
      type: 'reaction-changed';
      peerId: string;
      messageId: number;
      reactions: TelegramReaction[];
    }
  | {
      type: 'activity';
      activity: TelegramActivity;
    }
  | {
      type: 'activity-ended';
      peerId: string;
      senderId: string;
    }
  | {
      type: 'presence-changed';
      peerId: string;
      presence: 'online' | 'recently' | 'offline';
      lastSeenAt?: number | undefined;
    }
  | {
      type: 'mute-changed';
      peerId: string;
      muted: boolean;
    }
  | {
      type: 'dialog-pinned';
      peerId: string;
      pinned: boolean;
    }
  | {
      type: 'expression-index-changed';
      kind: 'stickers' | 'gifs' | 'all';
    }
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
  | {
      type: 'bot-commands-changed';
      peerId: string;
      botId?: string | undefined;
    }
  | {
      type: 'pts-advanced';
      pts: number;
      ptsCount: number;
      channelScoped?: boolean | undefined;
    }
  | {
      type: 'dialog-list-invalidated';
    }
  | {
      type: 'channel-too-long';
      peerId: string;
    }
  | {
      type: 'connection-state';
      connected: boolean;
    }
  | {
      type: 'too-long';
    };

export interface TransportUpdateBatch {
  updates: TransportUpdate[];
  date?: number | undefined;
  seq?: number | undefined;
  seqStart?: number | undefined;
}

export type DifferenceResult =
  | {
      type: 'complete';
      cursor: SyncCursor;
      updates: TransportUpdate[];
    }
  | {
      type: 'too-long';
      cursor: SyncCursor;
    };

export type ChannelDifferenceResult =
  | {
      type: 'complete';
      pts: number;
      updates: TransportUpdate[];
    }
  | {
      type: 'too-long';
      pts: number;
    };

export interface DialogPage {
  dialogs: TelegramDialog[];
  nextOffset?: string;
}

export interface HistoryPage {
  messages: TelegramMessage[];
  hasOlder: boolean;
  nextBeforeMessageId?: number | undefined;
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

export interface TelegramTransport {
  connect(credentials: TelegramCredentials): Promise<void>;
  disconnect(): Promise<void>;
  logOut(): Promise<void>;
  isAuthorized(): Promise<boolean>;
  getAuthorizedAccountId(): Promise<string>;
  requestCode(phoneNumber: string): Promise<{ isCodeViaApp: boolean }>;
  submitCode(code: string): Promise<'authorized' | 'password-required' | 'sign-up-required'>;
  submitPassword(password: string): Promise<void>;
  getCurrentState(): Promise<SyncCursor>;
  getDifference(cursor: SyncCursor, totalLimit: number): Promise<DifferenceResult>;
  getChannelDifference(
    peer: TelegramPeer,
    pts: number,
    totalLimit: number,
  ): Promise<ChannelDifferenceResult>;
  getDialogs(limit: number): Promise<DialogPage>;
  getDialog?(peer: TelegramPeer): Promise<TelegramDialog | undefined>;
  searchPeers(query: string, limit?: number): Promise<TelegramPeerSearchResult[]>;
  getHistory(peer: TelegramPeer, limit: number, beforeMessageId?: number): Promise<HistoryPage>;
  getHistoryAround?(
    peer: TelegramPeer,
    messageId: number,
    limit: number,
  ): Promise<TelegramMessage[]>;
  readHistory(peer: TelegramPeer, maxMessageId: number): Promise<TransportMutationResult>;
  getReadOutboxMaxId?(peer: TelegramPeer): Promise<number>;
  getSharedMediaCounts(peer: TelegramPeer): Promise<SharedMediaCounts>;
  getSharedMedia(
    peer: TelegramPeer,
    kind: SharedMediaKind,
    limit: number,
    offset?: TelegramSearchOffset,
  ): Promise<TelegramSearchPage>;
  searchMessages(
    query: string,
    peer?: TelegramPeer,
    limit?: number,
    offset?: TelegramSearchOffset,
  ): Promise<TelegramSearchPage>;
  getPinnedMessages(peer: TelegramPeer): Promise<TelegramMessage[]>;
  getUserDetails(peer: TelegramPeer): Promise<TelegramUserDetails>;
  updateContact?(
    peer: TelegramPeer,
    firstName: string,
    lastName: string,
    phone: string,
  ): Promise<void>;
  deleteContact?(peer: TelegramPeer): Promise<void>;
  getGroupMembers?(peer: TelegramPeer, limit?: number): Promise<TelegramGroupMember[]>;
  setMuted(peer: TelegramPeer, muted: boolean): Promise<void>;
  setBlocked(peer: TelegramPeer, blocked: boolean): Promise<void>;
  setPinnedDialog(peer: TelegramPeer, pinned: boolean): Promise<void>;
  setArchived(peer: TelegramPeer, archived: boolean): Promise<TransportMutationResult>;
  deleteDialog(peer: TelegramPeer): Promise<TransportMutationResult>;
  setPinnedMessage(
    peer: TelegramPeer,
    messageId: number,
    pinned: boolean,
  ): Promise<TransportMutationResult>;
  setTyping(peer: TelegramPeer, kind?: TelegramActivityKind): Promise<void>;
  sendText(
    peer: TelegramPeer,
    text: string,
    randomId: string,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ): Promise<SendTextResult>;
  sendFile(peer: TelegramPeer, file: File, options: SendFileOptions): Promise<SendTextResult>;
  sendAlbum(
    peer: TelegramPeer,
    attachments: SendAlbumAttachment[],
    options: SendAlbumOptions,
  ): Promise<SendAlbumResult>;
  downloadMedia(message: TelegramMessage): Promise<Blob>;
  downloadAvatar(peer: TelegramPeer): Promise<Blob | undefined>;
  getRecentStickers(): Promise<TelegramSticker[]>;
  getStickerPacks(): Promise<TelegramStickerPack[]>;
  getSavedGifs(): Promise<TelegramSticker[]>;
  searchGifs?(peer: TelegramPeer, query: string): Promise<TelegramSticker[]>;
  downloadSticker(sticker: TelegramSticker): Promise<Blob>;
  downloadCustomEmoji?(documentId: string): Promise<Blob>;
  getBotCommands?(peer: TelegramPeer): Promise<TelegramBotCommand[]>;
  startBot?(peer: TelegramPeer, startParam: string, randomId: string): Promise<SendTextResult>;
  answerBotCallback?(
    peer: TelegramPeer,
    messageId: number,
    data: number[],
  ): Promise<TelegramBotCallbackResult>;
  requestUrlAuth?(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
  ): Promise<TelegramUrlAuthResult>;
  acceptUrlAuth?(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
    options?: TelegramUrlAuthAcceptOptions,
  ): Promise<TelegramUrlAuthResult>;
  sendSticker(
    peer: TelegramPeer,
    sticker: TelegramSticker,
    randomId: string,
    reply?: TelegramReplyTarget,
  ): Promise<SendTextResult>;
  setReaction(
    peer: TelegramPeer,
    messageId: number,
    emoji?: string,
  ): Promise<TransportMutationResult>;
  deleteMessages(
    peer: TelegramPeer,
    messageIds: number[],
    revoke: boolean,
  ): Promise<TransportMutationResult>;
  editMessage(
    peer: TelegramPeer,
    messageId: number,
    text: string,
    formats?: TelegramTextFormat[],
    replacement?: EditMediaOptions,
  ): Promise<EditMessageResult>;
  forwardMessage(
    fromPeer: TelegramPeer,
    toPeer: TelegramPeer,
    messageId: number,
    randomId: string,
  ): Promise<SendTextResult>;
  subscribe(listener: (batch: TransportUpdateBatch) => void): () => void;
}

export type OutgoingAttachmentMode = 'media' | 'file';

export interface SendFileOptions {
  caption: string;
  randomId: string;
  asSticker: boolean;
  sendAs: OutgoingAttachmentMode;
  reply?: TelegramReplyTarget | undefined;
  formats?: TelegramTextFormat[] | undefined;
  onProgress?: ((progress: number) => void) | undefined;
}

export interface SendAlbumAttachment {
  file: File;
  randomId: string;
  sendAs: 'media';
}

export interface SendAlbumOptions {
  caption: string;
  reply?: TelegramReplyTarget | undefined;
  formats?: TelegramTextFormat[] | undefined;
  onProgress?: ((progress: number) => void) | undefined;
}

export interface EditMediaOptions {
  file: File;
  sendAs: OutgoingAttachmentMode;
}

export interface PendingAttachment {
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
  formats?: TelegramTextFormat[] | undefined;
  sticker?: TelegramSticker | undefined;
  forward?:
    | {
        fromPeer: TelegramPeer;
        messageId: number;
      }
    | undefined;
  botStart?:
    | {
        startParam: string;
      }
    | undefined;
  attachment?: PendingAttachment | undefined;
  album?:
    | {
        attachments: PendingAlbumAttachment[];
      }
    | undefined;
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

export interface EngineSnapshot {
  phase: 'idle' | 'connecting' | 'unauthorized' | 'syncing' | 'ready' | 'error';
  sync: 'current' | 'recovering' | 'stale';
  online: boolean;
  dialogs: TelegramDialog[];
  activePeerId?: string | undefined;
  messages: TelegramMessage[];
  drafts: Record<string, string>;
  pending: PendingSend[];
  loadingMessages: boolean;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  sharedMediaCounts?: SharedMediaCounts | undefined;
  pinnedMessages: TelegramMessage[];
  historyGaps: TelegramHistoryGap[];
  activities: TelegramActivity[];
  expressionRevision: number;
  botCommandsRevision: number;
  groupMembersRevision: number;
  authStep?: 'phone' | 'code' | 'password' | undefined;
  codeViaApp?: boolean | undefined;
  historyError?: string | undefined;
  historyRetryAt?: number | undefined;
  operationError?: string | undefined;
  error?: string | undefined;
}
