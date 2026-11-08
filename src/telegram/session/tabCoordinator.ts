import type { TelegramPeer } from '../types';
import { messageInSavedDialog } from '../savedMessages';
import { messageInTopic } from '../forums';
import { Deferred, Effect, Exit, Queue, Schema, Scope, Stream } from 'effect';

import { makeConversation } from '../core/conversation';
import { reportDiagnostic } from '../core/diagnostics';
import { messagingCapabilities, type EffectMessagingClient } from '../core/client';
import type { MessagingEngine } from '../core/engine';
import { telegramMediaAssetKey } from '../core/mediaAssetKey';
import {
  MessagingErrorPayload,
  messagingErrorFromPayload,
  messagingErrorPayload,
  toMessagingError,
} from '../core/messagingError';
import { makeResourceCache, type ResourceCache } from '../core/resourceCache';
import {
  EngineState,
  accountSnapshot,
  conversationViewSnapshot,
  engineSnapshot,
  initialEngineSnapshot,
  mergeAccountSnapshot,
  shareEqualSnapshotFields,
} from '../core/engineState';
import { CoordinatorTasks } from './coordinatorTasks';
import { acquireAvailableTabLease } from './tabLock';
import { applyConversationChange, makeClientRegistry } from './clientRegistry';
import { makeRequestJournal, type PendingRequest } from './requestJournal';
import type {
  AccountSnapshot,
  ConversationViewSnapshot,
  EngineSnapshot,
  TelegramCredentials,
  TelegramConversationEvent,
  TelegramDownloadOptions,
  TelegramHistoryGap,
  TelegramMessage,
  TelegramResourceInvalidation,
} from '../types';

const PROTOCOL_VERSION = 30;
const OWNER_HEARTBEAT_MS = 2_000;
const OWNER_TIMEOUT_MS = 7_000;
const REQUEST_RETRY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_COMPLETED_REQUESTS = 128;
const CHANNEL_ERROR = 'This browser cannot provide the channel required for safe multi-tab sync.';
const LOCKS_ERROR = 'This browser cannot provide the locking required for safe multi-tab sync.';
const LOCK_ACCESS_ERROR =
  'This browser could not access the locking required for safe multi-tab sync.';

type RemoteMethod = Exclude<
  keyof EffectMessagingClient,
  | 'snapshot'
  | 'subscribe'
  | 'subscribeResources'
  | 'subscribeConversationEvents'
  | 'start'
  | 'stop'
  | 'conversation'
  | 'mediaAssetKey'
  | 'loadCachedAvatar'
>;

type RemoteArguments<Method extends RemoteMethod> = EffectMessagingClient[Method] extends (
  ...args: infer Arguments
) => unknown
  ? Arguments
  : never;

type RemoteResult<Method extends RemoteMethod> = EffectMessagingClient[Method] extends (
  ...args: never[]
) => infer Result
  ? Result
  : never;

const invokeEngineCommand = (
  engine: MessagingEngine,
  method: RemoteMethod,
  args: readonly unknown[],
): Effect.Effect<unknown, unknown> => {
  switch (method) {
    case 'retrySync':
      return engine.retrySync();
    case 'refreshUpdates':
      return engine.refreshUpdates();
    case 'refreshReadReceipt':
      return engine.refreshReadReceipt(
        ...(args as Parameters<MessagingEngine['refreshReadReceipt']>),
      );
    case 'markAllNotificationsRead':
      return engine.markAllNotificationsRead(
        ...(args as Parameters<MessagingEngine['markAllNotificationsRead']>),
      );
    case 'markMessageNotificationsRead':
      return engine.markMessageNotificationsRead(
        ...(args as Parameters<MessagingEngine['markMessageNotificationsRead']>),
      );
    case 'getUnreadNotifications':
      return engine.getUnreadNotifications(
        ...(args as Parameters<MessagingEngine['getUnreadNotifications']>),
      );
    case 'markMediaRead':
      return engine.markMediaRead(...(args as Parameters<MessagingEngine['markMediaRead']>));
    case 'retryMarkRead':
      return engine.retryMarkRead(...(args as Parameters<MessagingEngine['retryMarkRead']>));
    case 'clearOperationError':
      return engine.clearOperationError();
    case 'beginQrLogin':
      return engine.beginQrLogin();
    case 'cancelQrLogin':
      return engine.cancelQrLogin();
    case 'requestCode':
      return engine.requestCode(...(args as Parameters<MessagingEngine['requestCode']>));
    case 'submitCode':
      return engine.submitCode(...(args as Parameters<MessagingEngine['submitCode']>));
    case 'submitPassword':
      return engine.submitPassword(...(args as Parameters<MessagingEngine['submitPassword']>));
    case 'logOut':
      return engine.logOut();
    case 'clearCache':
      return engine.clearCache();
    case 'loadConversationSharedMediaCounts':
      return engine.loadConversationSharedMediaCounts(
        ...(args as Parameters<MessagingEngine['loadConversationSharedMediaCounts']>),
      );
    case 'loadOlderConversationView':
      return engine.loadOlderConversationView(
        ...(args as Parameters<MessagingEngine['loadOlderConversationView']>),
      );
    case 'loadHistoryGapConversationView':
      return engine.loadHistoryGapConversationView(
        ...(args as Parameters<MessagingEngine['loadHistoryGapConversationView']>),
      );
    case 'retryConversationView':
      return engine.retryConversationView(
        ...(args as Parameters<MessagingEngine['retryConversationView']>),
      );
    case 'openMessageInConversationView':
      return engine.openMessageInConversationView(
        ...(args as Parameters<MessagingEngine['openMessageInConversationView']>),
      );
    case 'searchConversationMessages':
      return engine.searchConversationMessages(
        ...(args as Parameters<MessagingEngine['searchConversationMessages']>),
      );
    case 'getConversationSharedMedia':
      return engine.getConversationSharedMedia(
        ...(args as Parameters<MessagingEngine['getConversationSharedMedia']>),
      );
    case 'setActiveConversationVisibility':
      return engine.setActiveConversationVisibility(
        ...(args as Parameters<MessagingEngine['setActiveConversationVisibility']>),
      );
    case 'setDraft':
      return engine.setDraft(...(args as Parameters<MessagingEngine['setDraft']>));
    case 'setTyping':
      return engine.setTyping(...(args as Parameters<MessagingEngine['setTyping']>));
    case 'sendDraft':
      return engine.sendDraft(...(args as Parameters<MessagingEngine['sendDraft']>));
    case 'sendAttachments':
      return engine.sendAttachments(...(args as Parameters<MessagingEngine['sendAttachments']>));
    case 'updatePoll':
      return engine.updatePoll(...(args as Parameters<MessagingEngine['updatePoll']>));
    case 'sendPoll':
      return engine.sendPoll(...(args as Parameters<MessagingEngine['sendPoll']>));
    case 'sendContact':
      return engine.sendContact(...(args as Parameters<MessagingEngine['sendContact']>));
    case 'sendSticker':
      return engine.sendSticker(...(args as Parameters<MessagingEngine['sendSticker']>));
    case 'forwardMessage':
      return engine.forwardMessage(...(args as Parameters<MessagingEngine['forwardMessage']>));
    case 'editMessage':
      return engine.editMessage(...(args as Parameters<MessagingEngine['editMessage']>));
    case 'deleteMessage':
      return engine.deleteMessage(...(args as Parameters<MessagingEngine['deleteMessage']>));
    case 'deleteForumTopic':
      return engine.deleteForumTopic(...(args as Parameters<MessagingEngine['deleteForumTopic']>));
    case 'getForumTopic':
      return engine.getForumTopic(...(args as Parameters<MessagingEngine['getForumTopic']>));
    case 'getForumTopics':
      return engine.getForumTopics(...(args as Parameters<MessagingEngine['getForumTopics']>));
    case 'createForumTopic':
      return engine.createForumTopic(...(args as Parameters<MessagingEngine['createForumTopic']>));
    case 'editForumTopic':
      return engine.editForumTopic(...(args as Parameters<MessagingEngine['editForumTopic']>));
    case 'pinForumTopic':
      return engine.pinForumTopic(...(args as Parameters<MessagingEngine['pinForumTopic']>));
    case 'readForumTopic':
      return engine.readForumTopic(...(args as Parameters<MessagingEngine['readForumTopic']>));
    case 'checkChatInvite':
      return engine.checkChatInvite(...(args as Parameters<MessagingEngine['checkChatInvite']>));
    case 'joinChatInvite':
      return engine.joinChatInvite(...(args as Parameters<MessagingEngine['joinChatInvite']>));
    case 'getJoinRequests':
      return engine.getJoinRequests(...(args as Parameters<MessagingEngine['getJoinRequests']>));
    case 'resolveJoinRequest':
      return engine.resolveJoinRequest(
        ...(args as Parameters<MessagingEngine['resolveJoinRequest']>),
      );
    case 'resolveAllJoinRequests':
      return engine.resolveAllJoinRequests(
        ...(args as Parameters<MessagingEngine['resolveAllJoinRequests']>),
      );
    case 'getChatInviteLinks':
      return engine.getChatInviteLinks(
        ...(args as Parameters<MessagingEngine['getChatInviteLinks']>),
      );
    case 'exportChatInviteLink':
      return engine.exportChatInviteLink(
        ...(args as Parameters<MessagingEngine['exportChatInviteLink']>),
      );
    case 'editChatInviteLink':
      return engine.editChatInviteLink(
        ...(args as Parameters<MessagingEngine['editChatInviteLink']>),
      );
    case 'revokeChatInviteLink':
      return engine.revokeChatInviteLink(
        ...(args as Parameters<MessagingEngine['revokeChatInviteLink']>),
      );
    case 'deleteChatInviteLink':
      return engine.deleteChatInviteLink(
        ...(args as Parameters<MessagingEngine['deleteChatInviteLink']>),
      );
    case 'getSavedMessagesInfo':
      return engine.getSavedMessagesInfo(
        ...(args as Parameters<MessagingEngine['getSavedMessagesInfo']>),
      );
    case 'getSavedDialogs':
      return engine.getSavedDialogs(...(args as Parameters<MessagingEngine['getSavedDialogs']>));
    case 'getEarlierGroupHistory':
      return engine.getEarlierGroupHistory(
        ...(args as Parameters<MessagingEngine['getEarlierGroupHistory']>),
      );
    case 'getSavedHistory':
      return engine.getSavedHistory(...(args as Parameters<MessagingEngine['getSavedHistory']>));
    case 'getSavedTags':
      return engine.getSavedTags(...(args as Parameters<MessagingEngine['getSavedTags']>));
    case 'renameSavedTag':
      return engine.renameSavedTag(...(args as Parameters<MessagingEngine['renameSavedTag']>));
    case 'pinSavedDialog':
      return engine.pinSavedDialog(...(args as Parameters<MessagingEngine['pinSavedDialog']>));
    case 'setSavedMessageTags':
      return engine.setSavedMessageTags(
        ...(args as Parameters<MessagingEngine['setSavedMessageTags']>),
      );
    case 'getAdminLog':
      return engine.getAdminLog(...(args as Parameters<MessagingEngine['getAdminLog']>));
    case 'upgradeChat':
      return engine.upgradeChat(...(args as Parameters<MessagingEngine['upgradeChat']>));
    case 'getChatManagement':
      return engine.getChatManagement(
        ...(args as Parameters<MessagingEngine['getChatManagement']>),
      );
    case 'setChatSetting':
      return engine.setChatSetting(...(args as Parameters<MessagingEngine['setChatSetting']>));
    case 'getManagedParticipants':
      return engine.getManagedParticipants(
        ...(args as Parameters<MessagingEngine['getManagedParticipants']>),
      );
    case 'addChatMember':
      return engine.addChatMember(...(args as Parameters<MessagingEngine['addChatMember']>));
    case 'editChatParticipant':
      return engine.editChatParticipant(
        ...(args as Parameters<MessagingEngine['editChatParticipant']>),
      );
    case 'createChat':
      return engine.createChat(...(args as Parameters<MessagingEngine['createChat']>));
    case 'getChatFolders':
      return engine.getChatFolders(...(args as Parameters<MessagingEngine['getChatFolders']>));
    case 'saveChatFolder':
      return engine.saveChatFolder(...(args as Parameters<MessagingEngine['saveChatFolder']>));
    case 'deleteChatFolder':
      return engine.deleteChatFolder(...(args as Parameters<MessagingEngine['deleteChatFolder']>));
    case 'reorderChatFolders':
      return engine.reorderChatFolders(
        ...(args as Parameters<MessagingEngine['reorderChatFolders']>),
      );
    case 'getFolderUpdates':
      return engine.getFolderUpdates(...(args as Parameters<MessagingEngine['getFolderUpdates']>));
    case 'joinFolderUpdates':
      return engine.joinFolderUpdates(
        ...(args as Parameters<MessagingEngine['joinFolderUpdates']>),
      );
    case 'getFolderLinks':
      return engine.getFolderLinks(...(args as Parameters<MessagingEngine['getFolderLinks']>));
    case 'exportFolderLink':
      return engine.exportFolderLink(...(args as Parameters<MessagingEngine['exportFolderLink']>));
    case 'deleteFolderLink':
      return engine.deleteFolderLink(...(args as Parameters<MessagingEngine['deleteFolderLink']>));
    case 'checkFolderInvite':
      return engine.checkFolderInvite(
        ...(args as Parameters<MessagingEngine['checkFolderInvite']>),
      );
    case 'joinFolderInvite':
      return engine.joinFolderInvite(...(args as Parameters<MessagingEngine['joinFolderInvite']>));
    case 'getPrivacy':
      return engine.getPrivacy(...(args as Parameters<MessagingEngine['getPrivacy']>));
    case 'setPrivacy':
      return engine.setPrivacy(...(args as Parameters<MessagingEngine['setPrivacy']>));
    case 'getReadTimePrivacy':
      return engine.getReadTimePrivacy();
    case 'setReadTimePrivacy':
      return engine.setReadTimePrivacy(
        ...(args as Parameters<MessagingEngine['setReadTimePrivacy']>),
      );
    case 'getActiveSessions':
      return engine.getActiveSessions();
    case 'terminateSession':
      return engine.terminateSession(...(args as Parameters<MessagingEngine['terminateSession']>));
    case 'setSessionTtl':
      return engine.setSessionTtl(...(args as Parameters<MessagingEngine['setSessionTtl']>));
    case 'getPollVotes':
      return engine.getPollVotes(...(args as Parameters<MessagingEngine['getPollVotes']>));
    case 'getMessageReadReceipts':
      return engine.getMessageReadReceipts(
        ...(args as Parameters<MessagingEngine['getMessageReadReceipts']>),
      );
    case 'getReactionPeople':
      return engine.getReactionPeople(
        ...(args as Parameters<MessagingEngine['getReactionPeople']>),
      );
    case 'toggleReaction':
      return engine.toggleReaction(...(args as Parameters<MessagingEngine['toggleReaction']>));
    case 'retryPendingSend':
      return engine.retryPendingSend(...(args as Parameters<MessagingEngine['retryPendingSend']>));
    case 'cancelPendingSend':
      return engine.cancelPendingSend(
        ...(args as Parameters<MessagingEngine['cancelPendingSend']>),
      );
    case 'retryOutbox':
      return engine.retryOutbox();
    case 'getLinkedMessage':
      return engine.getLinkedMessage(...(args as Parameters<MessagingEngine['getLinkedMessage']>));
    case 'resolveUsername':
      return engine.resolveUsername(...(args as Parameters<MessagingEngine['resolveUsername']>));
    case 'getDiscussion':
      return engine.getDiscussion(...(args as Parameters<MessagingEngine['getDiscussion']>));
    case 'getReplies':
      return engine.getReplies(...(args as Parameters<MessagingEngine['getReplies']>));
    case 'searchPeers':
      return engine.searchPeers(...(args as Parameters<MessagingEngine['searchPeers']>));
    case 'addPeer':
      return engine.addPeer(...(args as Parameters<MessagingEngine['addPeer']>));
    case 'getUserDetails':
      return engine.getUserDetails(...(args as Parameters<MessagingEngine['getUserDetails']>));
    case 'getGroupMembers':
      return engine.getGroupMembers(...(args as Parameters<MessagingEngine['getGroupMembers']>));
    case 'setUnreadMark':
      return engine.setUnreadMark(...(args as Parameters<MessagingEngine['setUnreadMark']>));
    case 'setMuted':
      return engine.setMuted(...(args as Parameters<MessagingEngine['setMuted']>));
    case 'setBlocked':
      return engine.setBlocked(...(args as Parameters<MessagingEngine['setBlocked']>));
    case 'updateContact':
      return engine.updateContact(...(args as Parameters<MessagingEngine['updateContact']>));
    case 'deleteContact':
      return engine.deleteContact(...(args as Parameters<MessagingEngine['deleteContact']>));
    case 'setPinnedDialog':
      return engine.setPinnedDialog(...(args as Parameters<MessagingEngine['setPinnedDialog']>));
    case 'setPinnedMessage':
      return engine.setPinnedMessage(...(args as Parameters<MessagingEngine['setPinnedMessage']>));
    case 'setArchived':
      return engine.setArchived(...(args as Parameters<MessagingEngine['setArchived']>));
    case 'deleteDialog':
      return engine.deleteDialog(...(args as Parameters<MessagingEngine['deleteDialog']>));
    case 'getWallpapers':
      return engine.getWallpapers();
    case 'getChatAppearance':
      return engine.getChatAppearance(
        ...(args as Parameters<MessagingEngine['getChatAppearance']>),
      );
    case 'downloadWallpaper':
      return engine.downloadWallpaper(
        ...(args as Parameters<MessagingEngine['downloadWallpaper']>),
      );
    case 'getFavoriteStickers':
      return engine.getFavoriteStickers();
    case 'setStickerFavorite':
      return engine.setStickerFavorite(
        ...(args as Parameters<MessagingEngine['setStickerFavorite']>),
      );
    case 'searchStickers':
      return engine.searchStickers(...(args as Parameters<MessagingEngine['searchStickers']>));
    case 'getRecentStickers':
      return engine.getRecentStickers();
    case 'getStickerPack':
      return engine.getStickerPack(...(args as Parameters<MessagingEngine['getStickerPack']>));
    case 'searchStickerPacks':
      return engine.searchStickerPacks(
        ...(args as Parameters<MessagingEngine['searchStickerPacks']>),
      );
    case 'setStickerPackInstalled':
      return engine.setStickerPackInstalled(
        ...(args as Parameters<MessagingEngine['setStickerPackInstalled']>),
      );
    case 'getStickerPacks':
      return engine.getStickerPacks();
    case 'getSavedGifs':
      return engine.getSavedGifs();
    case 'searchGifs':
      return engine.searchGifs(...(args as Parameters<MessagingEngine['searchGifs']>));
    case 'getBotCommands':
      return engine.getBotCommands(...(args as Parameters<MessagingEngine['getBotCommands']>));
    case 'startBot':
      return engine.startBot(...(args as Parameters<MessagingEngine['startBot']>));
    case 'answerBotCallback':
      return engine.answerBotCallback(
        ...(args as Parameters<MessagingEngine['answerBotCallback']>),
      );
    case 'getBotApp':
      return engine.getBotApp(...(args as Parameters<MessagingEngine['getBotApp']>));
    case 'requestWebApp':
      return engine.requestWebApp(...(args as Parameters<MessagingEngine['requestWebApp']>));
    case 'prolongWebApp':
      return engine.prolongWebApp(...(args as Parameters<MessagingEngine['prolongWebApp']>));
    case 'sendWebAppData':
      return engine.sendWebAppData(...(args as Parameters<MessagingEngine['sendWebAppData']>));
    case 'invokeWebAppMethod':
      return engine.invokeWebAppMethod(
        ...(args as Parameters<MessagingEngine['invokeWebAppMethod']>),
      );
    case 'requestUrlAuth':
      return engine.requestUrlAuth(...(args as Parameters<MessagingEngine['requestUrlAuth']>));
    case 'acceptUrlAuth':
      return engine.acceptUrlAuth(...(args as Parameters<MessagingEngine['acceptUrlAuth']>));
    case 'downloadAvatar':
      return engine.downloadAvatar(...(args as Parameters<MessagingEngine['downloadAvatar']>));
    case 'downloadMedia':
      return engine.downloadMedia(...(args as Parameters<MessagingEngine['downloadMedia']>));
    case 'downloadSticker':
      return engine.downloadSticker(...(args as Parameters<MessagingEngine['downloadSticker']>));
    case 'downloadCustomEmoji':
      return engine.downloadCustomEmoji(
        ...(args as Parameters<MessagingEngine['downloadCustomEmoji']>),
      );
    case 'openConversation':
      return Effect.fail(new Error('openConversation is handled by the coordinator view router.'));
  }
};

const localCapabilities = new Set<keyof EffectMessagingClient>([
  'snapshot',
  'subscribe',
  'subscribeResources',
  'subscribeConversationEvents',
  'start',
  'stop',
  'conversation',
  'mediaAssetKey',
  'loadCachedAvatar',
]);
const remoteCapabilities = messagingCapabilities.filter(
  (method): method is RemoteMethod => !localCapabilities.has(method),
);
const RemoteMethodSchema = Schema.Literals(remoteCapabilities as [RemoteMethod, ...RemoteMethod[]]);

type CoordinatorInternalEvent =
  | { readonly _tag: 'message'; readonly input: unknown }
  | { readonly _tag: 'snapshot'; readonly snapshot: AccountSnapshot }
  | { readonly _tag: 'resource'; readonly event: TelegramResourceInvalidation }
  | { readonly _tag: 'conversation'; readonly event: TelegramConversationEvent }
  | { readonly _tag: 'pagehide' };

function isCrossTabValue(input: unknown, seen: WeakSet<object> = new WeakSet<object>()): boolean {
  if (
    input === null ||
    input === undefined ||
    typeof input === 'string' ||
    typeof input === 'number' ||
    typeof input === 'boolean' ||
    typeof input === 'bigint'
  ) {
    return true;
  }
  if (typeof input !== 'object') return false;
  if (
    input instanceof Blob ||
    input instanceof ArrayBuffer ||
    ArrayBuffer.isView(input) ||
    input instanceof Date
  ) {
    return true;
  }
  if (seen.has(input)) return true;
  seen.add(input);
  if (Array.isArray(input)) return input.every((value) => isCrossTabValue(value, seen));
  if (input instanceof Map) {
    return [...input].every(
      ([key, value]) => isCrossTabValue(key, seen) && isCrossTabValue(value, seen),
    );
  }
  if (input instanceof Set) return [...input].every((value) => isCrossTabValue(value, seen));
  const prototype: unknown = Object.getPrototypeOf(input);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(input).every((value) => isCrossTabValue(value, seen))
  );
}

const CrossTabValueSchema = Schema.declare(
  (input: unknown): input is unknown => isCrossTabValue(input),
  { identifier: 'CrossTabStructuredCloneValue' },
);

type CoordinatorMessage =
  | { type: 'hello'; version: number; from: string }
  | { type: 'client-heartbeat'; version: number; from: string }
  | { type: 'owner'; version: number; from: string; at: number }
  | { type: 'owner-gone'; version: number; from: string }
  | { type: 'client-gone'; version: number; from: string }
  | {
      type: 'state';
      version: number;
      from: string;
      to: string;
      account: AccountSnapshot;
      conversation: ConversationViewSnapshot;
      pendingPayloadIds?: string[] | undefined;
    }
  | { type: 'resource'; version: number; from: string; event: TelegramResourceInvalidation }
  | { type: 'conversation-event'; version: number; from: string; event: TelegramConversationEvent }
  | {
      type: 'request';
      version: number;
      from: string;
      id: string;
      method: RemoteMethod;
      args: unknown[];
    }
  | {
      type: 'response';
      version: number;
      from: string;
      to: string;
      id: string;
      result?: unknown;
      error?: MessagingErrorPayload;
    }
  | { type: 'version-mismatch'; version: number; from: string; to: string };

const envelope = { version: Schema.Number, from: Schema.String };
const PeerSchema = Schema.Struct({
  id: Schema.String,
  accessHash: Schema.optional(Schema.String),
  kind: Schema.Literals(['user', 'group', 'channel']),
});
const ChatPermissionsSchema = Schema.Struct({
  canSendMessages: Schema.Boolean,
  canSendMedia: Schema.Boolean,
  canSendStickers: Schema.Boolean,
  canSendPolls: Schema.optional(Schema.Boolean),
  canSendGifs: Schema.Boolean,
  canPinMessages: Schema.Boolean,
  canEditMessages: Schema.Boolean,
  canDeleteMessages: Schema.Boolean,
  canDeleteForEveryone: Schema.Boolean,
  canDeleteChat: Schema.Boolean,
  canDeleteChannel: Schema.Boolean,
  canLeave: Schema.Boolean,
  canViewMembers: Schema.Boolean,
  memberCount: Schema.optional(Schema.Number),
});
const UserDetailsSchema = Schema.Struct({
  botMenu: Schema.optional(Schema.Struct({ text: Schema.String, url: Schema.String })),
  botHasMainApp: Schema.optional(Schema.Boolean),
  firstName: Schema.optional(Schema.String),
  lastName: Schema.optional(Schema.String),
  phone: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
  bio: Schema.optional(Schema.String),
  birthday: Schema.optional(
    Schema.Struct({
      day: Schema.Number,
      month: Schema.Number,
      year: Schema.optional(Schema.Number),
    }),
  ),
  isContact: Schema.optional(Schema.Boolean),
  blocked: Schema.Boolean,
});
const ForwardedFromSchema = Schema.Struct({
  name: Schema.String,
  peerId: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.Number),
  hasAvatar: Schema.optional(Schema.Boolean),
  avatarId: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
});
const ServiceMessageSchema = Schema.Struct({
  kind: Schema.Literals([
    'chat-created',
    'title-changed',
    'photo-changed',
    'photo-removed',
    'users-added',
    'user-removed',
    'joined-by-link',
    'joined-by-request',
    'message-pinned',
    'history-cleared',
    'auto-delete-changed',
    'topic-created',
    'topic-changed',
    'screenshot-taken',
    'custom',
    'other',
  ]),
  text: Schema.String,
  actorId: Schema.optional(Schema.String),
  targetUserIds: Schema.optional(Schema.Array(Schema.String)),
  title: Schema.optional(Schema.String),
});
const BotButtonSchema = Schema.Struct({
  kind: Schema.Literals([
    'text',
    'url',
    'url-auth',
    'callback',
    'copy',
    'switch-inline',
    'web-app',
    'simple-web-app',
    'unsupported',
  ]),
  text: Schema.String,
  url: Schema.optional(Schema.String),
  buttonId: Schema.optional(Schema.Number),
  data: Schema.optional(Schema.Array(Schema.Number)),
  copyText: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  samePeer: Schema.optional(Schema.Boolean),
  botUsername: Schema.optional(Schema.String),
  bot: Schema.optional(PeerSchema),
});
const BotKeyboardSchema = Schema.Struct({
  kind: Schema.Literals(['inline', 'reply']),
  rows: Schema.Array(Schema.Array(BotButtonSchema)),
  hidden: Schema.optional(Schema.Boolean),
  forceReply: Schema.optional(Schema.Boolean),
  singleUse: Schema.optional(Schema.Boolean),
  persistent: Schema.optional(Schema.Boolean),
  placeholder: Schema.optional(Schema.String),
});
const MediaSchema = Schema.Struct({
  kind: Schema.Literals(['photo', 'video', 'round-video', 'voice', 'animation', 'sticker', 'file']),
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  duration: Schema.optional(Schema.Number),
  waveform: Schema.optional(Schema.Array(Schema.Number)),
  cacheKey: Schema.optional(Schema.String),
  spoiler: Schema.optional(Schema.Boolean),
});
const ReactionSchema = Schema.Struct({
  emoji: Schema.String,
  customEmojiId: Schema.optional(Schema.String),
  count: Schema.Number,
  chosen: Schema.Boolean,
});
const MentionSchema = Schema.Struct({
  offset: Schema.Number,
  length: Schema.Number,
  userId: Schema.optional(Schema.String),
});
const LinkSchema = Schema.Struct({
  offset: Schema.Number,
  length: Schema.Number,
  url: Schema.optional(Schema.String),
});
const LinkPreviewSchema = Schema.Struct({
  url: Schema.String,
  webPageId: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  hasEmbed: Schema.optional(Schema.Boolean),
  siteName: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  hasPhoto: Schema.optional(Schema.Boolean),
  photoSize: Schema.optional(Schema.Literals(['small', 'large'])),
  media: Schema.optional(MediaSchema),
});
const TextFormatSchema = Schema.Struct({
  userId: Schema.optional(Schema.String),
  accessHash: Schema.optional(Schema.String),
  offset: Schema.Number,
  length: Schema.Number,
  kind: Schema.Literals([
    'bold',
    'italic',
    'underline',
    'strike',
    'code',
    'pre',
    'spoiler',
    'blockquote',
    'expandableBlockquote',
    'mention',
    'mentionName',
    'textUrl',
    'customEmoji',
    'formattedDate',
    'diffInsert',
    'diffReplace',
    'diffDelete',
  ]),
  url: Schema.optional(Schema.String),
  customEmojiId: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Number),
  oldText: Schema.optional(Schema.String),
});
const DraftDetailsSchema = Schema.Struct({
  formats: Schema.Array(TextFormatSchema),
  reply: Schema.optional(
    Schema.Struct({
      messageId: Schema.Number,
      preview: Schema.String,
      quoteText: Schema.optional(Schema.String),
    }),
  ),
});
// BroadcastChannel uses structured clone, which preserves explicit undefined fields
// in rich blocks (for example a preformatted block without a language).
function isRichMessageValue(input: unknown, ancestors = new Set<object>()): boolean {
  if (
    input === undefined ||
    input === null ||
    typeof input === 'string' ||
    typeof input === 'boolean'
  )
    return true;
  if (typeof input === 'number') return Number.isFinite(input);
  if (typeof input !== 'object' || ancestors.has(input)) return false;
  const prototype: unknown = Object.getPrototypeOf(input);
  if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(input);
  const valid = Object.values(input).every((value) => isRichMessageValue(value, ancestors));
  ancestors.delete(input);
  return valid;
}
const RichMessageValueSchema = Schema.declare(
  (input: unknown): input is unknown => isRichMessageValue(input),
  { identifier: 'RichMessageStructuredCloneValue' },
);

const ContactSchema = Schema.Struct({
  phoneNumber: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  vcard: Schema.String,
  peer: Schema.optional(PeerSchema),
  hasAvatar: Schema.optional(Schema.Boolean),
  avatarId: Schema.optional(Schema.String),
});
const PollSchema = Schema.Struct({
  id: Schema.String,
  hash: Schema.String,
  question: Schema.String,
  answers: Schema.Array(Schema.Struct({ option: Schema.String, text: Schema.String })),
  closed: Schema.Boolean,
  publicVoters: Schema.Boolean,
  multipleChoice: Schema.Boolean,
  quiz: Schema.Boolean,
  revotingDisabled: Schema.Boolean,
  hideResultsUntilClose: Schema.Boolean,
  closeDate: Schema.optional(Schema.Number),
  results: Schema.Struct({
    min: Schema.optional(Schema.Boolean),
    totalVoters: Schema.optional(Schema.Number),
    solution: Schema.optional(Schema.String),
    answers: Schema.optional(
      Schema.Array(
        Schema.Struct({
          option: Schema.String,
          voters: Schema.Number,
          chosen: Schema.optional(Schema.Boolean),
          correct: Schema.optional(Schema.Boolean),
        }),
      ),
    ),
  }),
});
const MessageSchema = Schema.Struct({
  id: Schema.Number,
  peerId: Schema.String,
  peer: Schema.optional(PeerSchema),
  peerTitle: Schema.optional(Schema.String),
  permissions: Schema.optional(ChatPermissionsSchema),
  senderId: Schema.String,
  senderName: Schema.optional(Schema.String),
  senderHasAvatar: Schema.optional(Schema.Boolean),
  senderAvatarId: Schema.optional(Schema.String),
  senderColor: Schema.optional(Schema.String),
  senderColorVersion: Schema.optional(Schema.Number),
  senderRole: Schema.optional(Schema.String),
  senderRoleKind: Schema.optional(Schema.Literals(['owner', 'admin'])),
  text: Schema.String,
  date: Schema.Number,
  outgoing: Schema.Boolean,
  mediaUnread: Schema.optional(Schema.Boolean),
  unreadMention: Schema.optional(Schema.Boolean),
  unreadReaction: Schema.optional(Schema.Boolean),
  protected: Schema.optional(Schema.Boolean),
  editedAt: Schema.optional(Schema.Number),
  replyToId: Schema.optional(Schema.Number),
  topicId: Schema.optional(Schema.Number),
  savedPeerId: Schema.optional(Schema.String),
  reactionsAsTags: Schema.optional(Schema.Boolean),
  replyQuote: Schema.optional(Schema.String),
  randomId: Schema.optional(Schema.String),
  groupedId: Schema.optional(Schema.String),
  forwardedFrom: Schema.optional(ForwardedFromSchema),
  service: Schema.optional(ServiceMessageSchema),
  contact: Schema.optional(ContactSchema),
  poll: Schema.optional(PollSchema),
  botKeyboard: Schema.optional(BotKeyboardSchema),
  media: Schema.optional(MediaSchema),
  reactions: Schema.optional(Schema.Array(ReactionSchema)),
  mentions: Schema.optional(Schema.Array(MentionSchema)),
  links: Schema.optional(Schema.Array(LinkSchema)),
  linkPreview: Schema.optional(LinkPreviewSchema),
  formats: Schema.optional(Schema.Array(TextFormatSchema)),
  richMessage: Schema.optional(RichMessageValueSchema),
  pinned: Schema.optional(Schema.Boolean),
});
const DialogSchema = Schema.Struct({
  peer: PeerSchema,
  transient: Schema.optional(Schema.Boolean),
  channelPts: Schema.optional(Schema.Number),
  title: Schema.String,
  initials: Schema.String,
  color: Schema.String,
  username: Schema.optional(Schema.String),
  archived: Schema.optional(Schema.Boolean),
  topMessageId: Schema.Number,
  topMessage: Schema.optional(MessageSchema),
  unreadCount: Schema.Number,
  unreadMark: Schema.optional(Schema.Boolean),
  isContact: Schema.optional(Schema.Boolean),
  broadcast: Schema.optional(Schema.Boolean),
  forum: Schema.optional(Schema.Boolean),
  unreadMentionsCount: Schema.optional(Schema.Number),
  unreadReactionsCount: Schema.optional(Schema.Number),
  readInboxMaxId: Schema.Number,
  readOutboxMaxId: Schema.Number,
  muted: Schema.Boolean,
  pinned: Schema.Boolean,
  pinnedOrder: Schema.optional(Schema.Number),
  permissions: Schema.optional(ChatPermissionsSchema),
  bot: Schema.optional(Schema.Boolean),
  hasAvatar: Schema.Boolean,
  avatarId: Schema.optional(Schema.String),
  presence: Schema.optional(Schema.Literals(['online', 'recently', 'offline'])),
  lastSeenAt: Schema.optional(Schema.Number),
  userDetails: Schema.optional(UserDetailsSchema),
});
const StickerSchema = Schema.Struct({
  id: Schema.String,
  accessHash: Schema.String,
  fileReference: Schema.instanceOf(Uint8Array),
  emoji: Schema.String,
  mimeType: Schema.String,
  dcId: Schema.optional(Schema.Number),
  size: Schema.optional(Schema.Number),
  title: Schema.optional(Schema.String),
  inlineQueryId: Schema.optional(Schema.String),
  inlineResultId: Schema.optional(Schema.String),
});
const PollDraftSchema = Schema.Struct({
  question: Schema.String,
  answers: Schema.Array(Schema.String),
  publicVoters: Schema.Boolean,
  multipleChoice: Schema.Boolean,
  quiz: Schema.Boolean,
  correctAnswer: Schema.optional(Schema.Number),
  solution: Schema.String,
});
const PendingSendSchema = Schema.Struct({
  id: Schema.String,
  accountId: Schema.optional(Schema.String),
  peer: PeerSchema,
  text: Schema.String,
  randomId: Schema.String,
  createdAt: Schema.Number,
  queueOrder: Schema.optional(Schema.Number),
  attempts: Schema.Number,
  lastError: Schema.optional(Schema.String),
  uploadProgress: Schema.optional(Schema.Number),
  reply: Schema.optional(
    Schema.Struct({
      messageId: Schema.Number,
      topMessageId: Schema.optional(Schema.Number),
      quoteText: Schema.optional(Schema.String),
    }),
  ),
  formats: Schema.optional(Schema.Array(TextFormatSchema)),
  sticker: Schema.optional(StickerSchema),
  contact: Schema.optional(ContactSchema),
  pollDraft: Schema.optional(PollDraftSchema),
  forward: Schema.optional(
    Schema.Struct({
      fromPeer: PeerSchema,
      messageId: Schema.Number,
      options: Schema.optional(
        Schema.Struct({
          topMessageId: Schema.optional(Schema.Number),
          hideAuthor: Schema.optional(Schema.Boolean),
          hideCaption: Schema.optional(Schema.Boolean),
        }),
      ),
      mediaKind: Schema.optional(
        Schema.Literals(['photo', 'video', 'round-video', 'voice', 'animation', 'sticker', 'file']),
      ),
    }),
  ),
  botStart: Schema.optional(Schema.Struct({ startParam: Schema.String })),
});
const ActivitySchema = Schema.Struct({
  peerId: Schema.String,
  senderId: Schema.String,
  kind: Schema.Literals(['typing', 'uploading', 'recording', 'choosing-sticker']),
});
const SharedMediaCountsSchema = Schema.Struct({
  photos: Schema.Number,
  videos: Schema.Number,
  files: Schema.Number,
  audio: Schema.Number,
  links: Schema.Number,
  voice: Schema.Number,
  gifs: Schema.Number,
});
const HistoryGapSchema = Schema.Struct({
  olderMaxMessageId: Schema.Number,
  newerMinMessageId: Schema.Number,
});
const AccountSnapshotSchema = Schema.Struct({
  phase: Schema.Literals(['idle', 'connecting', 'unauthorized', 'syncing', 'ready', 'error']),
  sync: Schema.Literals(['current', 'recovering', 'stale']),
  online: Schema.Boolean,
  dialogs: Schema.Array(DialogSchema),
  drafts: Schema.Record(Schema.String, Schema.String),
  draftDetails: Schema.Record(Schema.String, DraftDetailsSchema),
  pending: Schema.Array(PendingSendSchema),
  activities: Schema.Array(ActivitySchema),
  authStep: Schema.optional(Schema.Literals(['phone', 'code', 'password', 'qr'])),
  qrLogin: Schema.optional(Schema.Struct({ url: Schema.String, expires: Schema.Number })),
  codeViaApp: Schema.optional(Schema.Boolean),
  operationError: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  requiresReload: Schema.optional(Schema.Boolean),
});
const ConversationViewSnapshotSchema = Schema.Struct({
  activePeerId: Schema.optional(Schema.String),
  activeTopicId: Schema.optional(Schema.Number),
  activeSavedPeer: Schema.optional(PeerSchema),
  messages: Schema.Array(MessageSchema),
  loadingMessages: Schema.Boolean,
  hasOlderMessages: Schema.Boolean,
  loadingOlderMessages: Schema.Boolean,
  sharedMediaCounts: Schema.optional(SharedMediaCountsSchema),
  pinnedMessages: Schema.Array(MessageSchema),
  historyGaps: Schema.Array(HistoryGapSchema),
  historyError: Schema.optional(Schema.String),
  historyRetryAt: Schema.optional(Schema.Number),
});
const ResourceInvalidationSchema = Schema.Struct({
  kind: Schema.Literals([
    'expressions',
    'bot-commands',
    'group-members',
    'peer-metadata',
    'chat-folders',
    'forum-topics',
    'web-app-result',
  ]),
  queryId: Schema.optional(Schema.String),
  peerId: Schema.optional(Schema.String),
});
const ConversationEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(['message-upsert']),
    message: MessageSchema,
    insertIfMissing: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literals(['messages-delete']),
    peerId: Schema.optional(Schema.String),
    messageIds: Schema.Array(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literals(['pinned-messages']),
    peerId: Schema.String,
    messages: Schema.Array(MessageSchema),
  }),
  Schema.Struct({
    type: Schema.Literals(['history-reset']),
    peerId: Schema.optional(Schema.String),
  }),
]);
const CoordinatorMessageSchema = Schema.Union([
  Schema.Struct({
    ...envelope,
    type: Schema.Literals(['conversation-event']),
    event: ConversationEventSchema,
  }),
  Schema.Struct({ ...envelope, type: Schema.Literals(['hello']) }),
  Schema.Struct({ ...envelope, type: Schema.Literals(['client-heartbeat']) }),
  Schema.Struct({ ...envelope, type: Schema.Literals(['owner']), at: Schema.Number }),
  Schema.Struct({ ...envelope, type: Schema.Literals(['owner-gone']) }),
  Schema.Struct({ ...envelope, type: Schema.Literals(['client-gone']) }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literals(['state']),
    to: Schema.String,
    account: AccountSnapshotSchema,
    conversation: ConversationViewSnapshotSchema,
    pendingPayloadIds: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literals(['resource']),
    event: ResourceInvalidationSchema,
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literals(['request']),
    id: Schema.String,
    method: RemoteMethodSchema,
    args: Schema.Array(CrossTabValueSchema),
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literals(['response']),
    to: Schema.String,
    id: Schema.String,
    result: Schema.optional(CrossTabValueSchema),
    error: Schema.optional(MessagingErrorPayload),
  }),
  Schema.Struct({ ...envelope, type: Schema.Literals(['version-mismatch']), to: Schema.String }),
]);
const decodeCoordinatorMessage = Schema.decodeUnknownEffect(CoordinatorMessageSchema);

export interface TabCoordinatorOwner {
  engine: MessagingEngine;
  transport?: unknown;
}

export interface TabCoordinatorOptions {
  key: string;
  createOwner(): Effect.Effect<TabCoordinatorOwner, unknown, Scope.Scope>;
  loadBlob(key: string): Effect.Effect<Blob | undefined, unknown>;
  hydrateSnapshot?(
    snapshot: EngineSnapshot,
    pendingPayloadIds: readonly string[],
  ): Effect.Effect<EngineSnapshot, unknown>;
  ownerChanged?(owner: TabCoordinatorOwner | undefined): Effect.Effect<void>;
}

// Each remote command declares its coordination policy in one place. Workspace
// reads can serve durable data during reconnect; the engine decides whether to
// refresh them. Concurrent commands must not wait behind a slow network mutation.
interface CommandPolicy {
  readiness: 'workspace' | 'startup' | 'account';
  concurrent?: boolean;
  coalesce?: boolean;
  surfaceError?: boolean;
}
const commandPolicies: Record<RemoteMethod, CommandPolicy> = {
  retrySync: { readiness: 'startup' },
  refreshUpdates: { readiness: 'account', coalesce: true },
  refreshReadReceipt: { readiness: 'account', coalesce: true },
  markAllNotificationsRead: { readiness: 'account', concurrent: true, coalesce: true },
  markMessageNotificationsRead: { readiness: 'account', concurrent: true, coalesce: true },
  getUnreadNotifications: { readiness: 'account', concurrent: true },
  markMediaRead: { readiness: 'account', concurrent: true, coalesce: true },
  retryMarkRead: { readiness: 'workspace' },
  clearOperationError: { readiness: 'workspace' },
  beginQrLogin: { readiness: 'startup' },
  cancelQrLogin: { readiness: 'startup' },
  requestCode: { readiness: 'startup' },
  submitCode: { readiness: 'startup' },
  submitPassword: { readiness: 'startup' },
  logOut: { readiness: 'workspace', surfaceError: true },
  clearCache: { readiness: 'workspace', surfaceError: true },
  openConversation: { readiness: 'workspace', concurrent: true },
  loadConversationSharedMediaCounts: { readiness: 'workspace', concurrent: true },
  loadOlderConversationView: { readiness: 'workspace', concurrent: true },
  loadHistoryGapConversationView: { readiness: 'workspace', concurrent: true },
  retryConversationView: { readiness: 'workspace', coalesce: true },
  openMessageInConversationView: { readiness: 'workspace', concurrent: true },
  searchConversationMessages: { readiness: 'workspace', concurrent: true },
  getConversationSharedMedia: { readiness: 'workspace', concurrent: true },
  setActiveConversationVisibility: { readiness: 'workspace' },
  setDraft: { readiness: 'workspace', concurrent: true, surfaceError: true },
  setTyping: { readiness: 'workspace', concurrent: true },
  sendDraft: { readiness: 'workspace', concurrent: true, surfaceError: true },
  sendAttachments: { readiness: 'workspace', concurrent: true, surfaceError: true },
  updatePoll: { readiness: 'workspace', concurrent: true, surfaceError: true },
  sendPoll: { readiness: 'workspace', concurrent: true, surfaceError: true },
  sendContact: { readiness: 'workspace', concurrent: true, surfaceError: true },
  sendSticker: { readiness: 'workspace', concurrent: true, surfaceError: true },
  forwardMessage: { readiness: 'workspace', concurrent: true, surfaceError: true },
  editMessage: { readiness: 'account', concurrent: true, surfaceError: true },
  deleteMessage: { readiness: 'account', concurrent: true, surfaceError: true },
  deleteForumTopic: { readiness: 'account', concurrent: true },
  getForumTopic: { readiness: 'account', concurrent: true },
  getForumTopics: { readiness: 'account', concurrent: true },
  createForumTopic: { readiness: 'account', concurrent: true },
  editForumTopic: { readiness: 'account', concurrent: true },
  pinForumTopic: { readiness: 'account', concurrent: true },
  readForumTopic: { readiness: 'account', concurrent: true },
  checkChatInvite: { readiness: 'account', concurrent: true },
  joinChatInvite: { readiness: 'account', concurrent: true },
  getJoinRequests: { readiness: 'account', concurrent: true },
  resolveJoinRequest: { readiness: 'account', concurrent: true },
  resolveAllJoinRequests: { readiness: 'account', concurrent: true },
  getChatInviteLinks: { readiness: 'account', concurrent: true },
  exportChatInviteLink: { readiness: 'account', concurrent: true },
  editChatInviteLink: { readiness: 'account', concurrent: true },
  revokeChatInviteLink: { readiness: 'account', concurrent: true },
  deleteChatInviteLink: { readiness: 'account', concurrent: true },
  getSavedMessagesInfo: { readiness: 'account', concurrent: true },
  getSavedDialogs: { readiness: 'account', concurrent: true },
  getSavedHistory: { readiness: 'account', concurrent: true },
  getEarlierGroupHistory: { readiness: 'account', concurrent: true },
  getSavedTags: { readiness: 'account', concurrent: true },
  renameSavedTag: { readiness: 'account', concurrent: true },
  pinSavedDialog: { readiness: 'account', concurrent: true },
  setSavedMessageTags: { readiness: 'account', concurrent: true },
  getAdminLog: { readiness: 'account', concurrent: true },
  upgradeChat: { readiness: 'account', concurrent: true },
  getChatManagement: { readiness: 'account', concurrent: true },
  setChatSetting: { readiness: 'account', concurrent: true },
  getManagedParticipants: { readiness: 'account', concurrent: true },
  addChatMember: { readiness: 'account', concurrent: true },
  editChatParticipant: { readiness: 'account', concurrent: true },
  createChat: { readiness: 'account', concurrent: true },
  getChatFolders: { readiness: 'account', concurrent: true },
  saveChatFolder: { readiness: 'account', concurrent: true },
  deleteChatFolder: { readiness: 'account', concurrent: true },
  reorderChatFolders: { readiness: 'account', concurrent: true },
  getFolderUpdates: { readiness: 'account', concurrent: true },
  joinFolderUpdates: { readiness: 'account', concurrent: true },
  getFolderLinks: { readiness: 'account', concurrent: true },
  exportFolderLink: { readiness: 'account', concurrent: true },
  deleteFolderLink: { readiness: 'account', concurrent: true },
  checkFolderInvite: { readiness: 'account', concurrent: true },
  joinFolderInvite: { readiness: 'account', concurrent: true },
  getPrivacy: { readiness: 'account', concurrent: true, coalesce: true },
  setPrivacy: { readiness: 'account' },
  getReadTimePrivacy: { readiness: 'account', concurrent: true, coalesce: true },
  setReadTimePrivacy: { readiness: 'account' },
  getActiveSessions: { readiness: 'account', concurrent: true, coalesce: true },
  terminateSession: { readiness: 'account' },
  setSessionTtl: { readiness: 'account' },
  getPollVotes: { readiness: 'account', concurrent: true, coalesce: true },
  getMessageReadReceipts: { readiness: 'account', concurrent: true, coalesce: true },
  getReactionPeople: { readiness: 'account', concurrent: true, coalesce: true },
  toggleReaction: { readiness: 'account', concurrent: true, surfaceError: true },
  retryPendingSend: { readiness: 'workspace', concurrent: true, surfaceError: true },
  cancelPendingSend: { readiness: 'workspace', concurrent: true, surfaceError: true },
  retryOutbox: { readiness: 'workspace', coalesce: true, surfaceError: true },
  getLinkedMessage: { readiness: 'workspace', concurrent: true },
  resolveUsername: { readiness: 'workspace', concurrent: true },
  getDiscussion: { readiness: 'workspace', concurrent: true },
  getReplies: { readiness: 'workspace', concurrent: true },
  searchPeers: { readiness: 'workspace', concurrent: true },
  addPeer: { readiness: 'account' },
  getUserDetails: { readiness: 'account', concurrent: true, coalesce: true },
  getGroupMembers: { readiness: 'workspace', concurrent: true, coalesce: true },
  setUnreadMark: { readiness: 'account', concurrent: true, surfaceError: true },
  setMuted: { readiness: 'account', concurrent: true, surfaceError: true },
  setBlocked: { readiness: 'account', concurrent: true, surfaceError: true },
  updateContact: { readiness: 'account', concurrent: true, surfaceError: true },
  deleteContact: { readiness: 'account', concurrent: true, surfaceError: true },
  setPinnedDialog: { readiness: 'account', concurrent: true, surfaceError: true },
  setPinnedMessage: { readiness: 'account', concurrent: true, surfaceError: true },
  setArchived: { readiness: 'account', concurrent: true, surfaceError: true },
  deleteDialog: { readiness: 'account', concurrent: true, surfaceError: true },
  getWallpapers: { readiness: 'workspace' },
  getChatAppearance: { readiness: 'workspace', concurrent: true, coalesce: true },
  downloadWallpaper: { readiness: 'account', concurrent: true },
  getFavoriteStickers: { readiness: 'workspace', concurrent: true },
  setStickerFavorite: { readiness: 'workspace' },
  searchStickers: { readiness: 'workspace', concurrent: true },
  getRecentStickers: { readiness: 'workspace', concurrent: true },
  getStickerPack: { readiness: 'workspace', concurrent: true },
  searchStickerPacks: { readiness: 'workspace', concurrent: true },
  setStickerPackInstalled: { readiness: 'workspace' },
  getStickerPacks: { readiness: 'workspace', concurrent: true },
  getSavedGifs: { readiness: 'workspace', concurrent: true },
  searchGifs: { readiness: 'workspace' },
  getBotCommands: { readiness: 'workspace', concurrent: true, coalesce: true },
  startBot: { readiness: 'workspace', concurrent: true, surfaceError: true },
  answerBotCallback: { readiness: 'account', concurrent: true, surfaceError: true },
  getBotApp: { readiness: 'account', concurrent: true },
  requestWebApp: { readiness: 'account' },
  prolongWebApp: { readiness: 'account' },
  sendWebAppData: { readiness: 'account' },
  invokeWebAppMethod: { readiness: 'account' },
  requestUrlAuth: { readiness: 'account' },
  acceptUrlAuth: { readiness: 'account', concurrent: true, surfaceError: true },
  downloadAvatar: { readiness: 'account', concurrent: true },
  downloadMedia: { readiness: 'account', concurrent: true },
  downloadSticker: { readiness: 'account', concurrent: true },
  downloadCustomEmoji: { readiness: 'account', concurrent: true },
};

function retainWorkspaceWhileStarting(
  previous: EngineSnapshot,
  next: AccountSnapshot,
): AccountSnapshot {
  if (
    previous.dialogs.length === 0 ||
    next.dialogs.length > 0 ||
    (next.phase !== 'idle' && next.phase !== 'connecting' && next.phase !== 'syncing')
  ) {
    return next;
  }
  return {
    ...accountSnapshot(previous),
    sync: 'recovering',
    online: false,
    operationError: next.operationError,
    error: next.error,
  };
}

function conversationLoadingSnapshot(
  previous: EngineSnapshot | undefined,
  peerId: string,
  topicId?: number,
  savedPeer?: TelegramPeer,
): ConversationViewSnapshot {
  if (
    previous?.activePeerId === peerId &&
    previous.activeTopicId === topicId &&
    previous.activeSavedPeer?.id === savedPeer?.id
  ) {
    return {
      ...conversationViewSnapshot(previous),
      loadingMessages: previous.messages.length === 0,
      loadingOlderMessages: false,
    };
  }
  return {
    ...conversationViewSnapshot(initialEngineSnapshot()),
    activePeerId: peerId,
    activeTopicId: topicId,
    activeSavedPeer: savedPeer,
    loadingMessages: true,
  };
}

function retainConversationMetadata(
  previous: EngineSnapshot | undefined,
  next: ConversationViewSnapshot,
): ConversationViewSnapshot {
  if (
    !previous ||
    previous.activePeerId !== next.activePeerId ||
    previous.activeTopicId !== next.activeTopicId ||
    previous.activeSavedPeer?.id !== next.activeSavedPeer?.id
  )
    return next;
  return {
    ...next,
    ...(next.pinnedMessages.length === 0 && previous.pinnedMessages.length > 0
      ? { pinnedMessages: previous.pinnedMessages }
      : {}),
    ...(next.sharedMediaCounts === undefined && previous.sharedMediaCounts !== undefined
      ? { sharedMediaCounts: previous.sharedMediaCounts }
      : {}),
  };
}

function transferableSnapshot(snapshot: EngineSnapshot): EngineSnapshot {
  return {
    ...snapshot,
    pending: snapshot.pending.map(
      ({ attachment: _attachment, album: _album, ...pending }) => pending,
    ),
  };
}

function pendingPayloadIds(snapshot: EngineSnapshot) {
  return snapshot.pending
    .filter((pending) => pending.attachment || pending.album)
    .map((pending) => pending.id);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns tab election, RPC, failover, and per-tab view snapshots behind one small
 * messaging interface. Only the elected owner constructs a MessagingEngine.
 */ function makeTabCoordinatorModule(
  options: TabCoordinatorOptions,
  state: EngineState,
  tasks: CoordinatorTasks,
  events: Queue.Queue<CoordinatorInternalEvent>,
  channel: BroadcastChannel | undefined,
  rootScope: Scope.Scope,
  coalescedOperations: ResourceCache,
) {
  const fork = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.forkIn(effect, rootScope);
  let coordinatorOptions = options;
  let engineState = state;
  let coordinatorTasks = tasks;
  let eventQueue = events;
  let client!: EffectMessagingClient;
  let thisClientId = crypto.randomUUID();
  let broadcastChannel: BroadcastChannel | undefined = channel;
  let requestJournal = makeRequestJournal<RemoteMethod>(MAX_COMPLETED_REQUESTS);
  let coalescedRequests = coalescedOperations;
  let clientRegistry = makeClientRegistry();
  let activeOwner: TabCoordinatorOwner | undefined;
  let activeCredentials: TelegramCredentials | undefined;
  let activeOwnerId: string | undefined;
  let ownerSeenAt = 0;
  let stateRevision = 0;
  let versionMismatch = false;
  let coordinationError: string | undefined;
  let ownerUnsubscribe: Effect.Effect<void> | undefined;
  let resourceUnsubscribe: Effect.Effect<void> | undefined;
  let conversationUnsubscribe: Effect.Effect<void> | undefined;
  let ownerStarting: Deferred.Deferred<void, unknown> | undefined;
  let activeOwnerScope: Scope.Closeable | undefined;
  let stopped = false;
  let lastVisibilityKey = '';
  const downloadSharedBlob = Effect.fn('TabCoordinator.downloadSharedBlob')(function* (
    key: string,
    method: RemoteMethod,
    args: unknown[],
    missingMessage: string,
  ) {
    const cached = yield* options.loadBlob(key);
    if (cached) return cached;
    const downloaded = yield* invokeCoalesced(method, args);
    if (downloaded instanceof Blob) return downloaded;
    const blob = yield* options.loadBlob(key);
    if (!blob) return yield* Effect.fail(new Error(missingMessage));
    return blob;
  });
  const clientOperation = <Value, Error, Requirements>(
    operation: string,
    effect: Effect.Effect<Value, Error, Requirements>,
  ) => effect.pipe(Effect.mapError((error) => toMessagingError(error, operation)));
  const target = {
    snapshot: () => currentSnapshot(),
    subscribe: (listener: (snapshot: EngineSnapshot) => void) => subscribe(listener),
    subscribeResources: (listener: (event: TelegramResourceInvalidation) => void) =>
      subscribeResources(listener),
    subscribeConversationEvents: (listener: (event: TelegramConversationEvent) => void) =>
      engineState.subscribeConversationEvents(listener),
    start: (credentials: TelegramCredentials) =>
      start(credentials).pipe(Effect.mapError((error) => toMessagingError(error, 'start'))),
    stop: () => stop().pipe(Effect.mapError((error) => toMessagingError(error, 'stop'))),
    conversation: (peerId: string, topicId?: number, savedPeer?: TelegramPeer) =>
      conversation(peerId, topicId, savedPeer),
    openConversation: (peerId: string, topicId?: number, savedPeer?: TelegramPeer) =>
      openConversation(peerId, topicId, savedPeer).pipe(
        Effect.mapError((error) => toMessagingError(error, 'openConversation')),
      ),
    clearOperationError: () => invoke('clearOperationError', []).pipe(Effect.ignore),
    setActiveConversationVisibility: (
      peerId: string | undefined,
      state: { visible: boolean; atBottom: boolean },
    ) => {
      return clientOperation(
        'setActiveConversationVisibility',
        Effect.gen(function* () {
          const key = JSON.stringify([
            peerId,
            currentSnapshot().activeTopicId,
            currentSnapshot().activeSavedPeer?.id,
            currentSnapshot().messages.at(-1)?.id,
            state,
          ]);
          if (key === lastVisibilityKey) return;
          lastVisibilityKey = key;
          return yield* invokeCoalesced('setActiveConversationVisibility', [peerId, state]).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                if (lastVisibilityKey === key) lastVisibilityKey = '';
              }),
            ),
            Effect.asVoid,
          );
        }),
      );
    },
    mediaAssetKey: (message: TelegramMessage) => mediaAssetKey(message),
    loadCachedAvatar: (peer: { id: string }, avatarId?: string) =>
      clientOperation(
        'loadCachedAvatar',
        coordinatorOptions.loadBlob(`avatar:${peer.id}:${avatarId ?? 'unknown'}`),
      ),
    downloadAvatar: (peer: { id: string }, avatarId?: string) =>
      clientOperation(
        'downloadAvatar',
        Effect.gen(function* () {
          const key = `avatar:${peer.id}:${avatarId ?? 'unknown'}`;
          const cached = yield* options.loadBlob(key);
          if (cached) return cached;
          const downloaded = yield* invokeCoalesced('downloadAvatar', [peer, avatarId]);
          if (downloaded instanceof Blob) return downloaded;
          return yield* options.loadBlob(key);
        }),
      ),
    downloadMedia: (message: TelegramMessage, options?: TelegramDownloadOptions) =>
      clientOperation(
        'downloadMedia',
        Effect.gen(function* () {
          const key = `${options?.preview ? 'preview:' : ''}${mediaAssetKey(message)}`;
          const cached = yield* coordinatorOptions.loadBlob(key);
          if (cached)
            return options?.range
              ? cached.slice(options.range.start, options.range.end + 1, cached.type)
              : cached;
          // Progress callbacks cannot cross BroadcastChannel. Keep them local when
          // this tab is the owner, but still use the normal readiness gate.
          if (options?.progress && activeOwner) {
            return (yield* callOwner('downloadMedia', [message, options])) as Blob;
          }
          const downloaded = yield* invokeCoalesced('downloadMedia', [
            message,
            options ? { preview: options.preview, range: options.range } : undefined,
          ]);
          if (downloaded instanceof Blob) return downloaded;
          if (options?.range)
            return yield* Effect.fail(new Error('The media range was not returned.'));
          const blob = yield* coordinatorOptions.loadBlob(key);
          if (!blob)
            return yield* Effect.fail(
              new Error('The downloaded media was not committed to the shared cache.'),
            );
          return blob;
        }),
      ),
    downloadSticker: (sticker: { id: string }) =>
      clientOperation(
        'downloadSticker',
        downloadSharedBlob(
          `sticker:${sticker.id}`,
          'downloadSticker',
          [sticker],
          'The downloaded sticker was not committed to the shared cache.',
        ),
      ),
    downloadCustomEmoji: (documentId: string) =>
      clientOperation(
        'downloadCustomEmoji',
        downloadSharedBlob(
          `custom-emoji:${documentId}`,
          'downloadCustomEmoji',
          [documentId],
          'The custom emoji was not committed to the shared cache.',
        ),
      ),
    downloadWallpaper: (wallpaperId: string) =>
      clientOperation(
        'downloadWallpaper',
        downloadSharedBlob(
          `wallpaper:${wallpaperId}`,
          'downloadWallpaper',
          [wallpaperId],
          'The wallpaper was not committed to the shared cache.',
        ),
      ),
  };
  const remote =
    <Method extends RemoteMethod>(method: Method) =>
    (...args: RemoteArguments<Method>): RemoteResult<Method> => {
      const operation = commandPolicies[method].coalesce
        ? invokeCoalesced(method, args)
        : invoke(method, args);
      const surfaced = commandPolicies[method].surfaceError
        ? surfaceCommandFailure(operation)
        : operation;
      return surfaced.pipe(
        Effect.mapError((error) => toMessagingError(error, method)),
      ) as RemoteResult<Method>;
    };
  client = {
    ...target,
    retrySync: remote('retrySync'),
    refreshUpdates: remote('refreshUpdates'),
    refreshReadReceipt: remote('refreshReadReceipt'),
    retryMarkRead: remote('retryMarkRead'),
    markMediaRead: remote('markMediaRead'),
    getUnreadNotifications: remote('getUnreadNotifications'),
    markAllNotificationsRead: remote('markAllNotificationsRead'),
    markMessageNotificationsRead: remote('markMessageNotificationsRead'),
    beginQrLogin: remote('beginQrLogin'),
    cancelQrLogin: remote('cancelQrLogin'),
    requestCode: remote('requestCode'),
    submitCode: remote('submitCode'),
    submitPassword: remote('submitPassword'),
    logOut: remote('logOut'),
    clearCache: remote('clearCache'),
    loadConversationSharedMediaCounts: remote('loadConversationSharedMediaCounts'),
    loadOlderConversationView: remote('loadOlderConversationView'),
    loadHistoryGapConversationView: remote('loadHistoryGapConversationView'),
    retryConversationView: remote('retryConversationView'),
    openMessageInConversationView: remote('openMessageInConversationView'),
    searchConversationMessages: remote('searchConversationMessages'),
    getConversationSharedMedia: remote('getConversationSharedMedia'),
    setDraft: remote('setDraft'),
    setTyping: remote('setTyping'),
    sendDraft: remote('sendDraft'),
    sendAttachments: remote('sendAttachments'),
    sendSticker: remote('sendSticker'),
    sendContact: remote('sendContact'),
    sendPoll: remote('sendPoll'),
    updatePoll: remote('updatePoll'),
    forwardMessage: remote('forwardMessage'),
    editMessage: remote('editMessage'),
    deleteMessage: remote('deleteMessage'),
    getReactionPeople: remote('getReactionPeople'),
    getMessageReadReceipts: remote('getMessageReadReceipts'),
    getPollVotes: remote('getPollVotes'),
    getActiveSessions: remote('getActiveSessions'),
    deleteForumTopic: remote('deleteForumTopic'),
    getForumTopic: remote('getForumTopic'),
    getForumTopics: remote('getForumTopics'),
    createForumTopic: remote('createForumTopic'),
    editForumTopic: remote('editForumTopic'),
    pinForumTopic: remote('pinForumTopic'),
    readForumTopic: remote('readForumTopic'),
    checkChatInvite: remote('checkChatInvite'),
    joinChatInvite: remote('joinChatInvite'),
    getJoinRequests: remote('getJoinRequests'),
    resolveJoinRequest: remote('resolveJoinRequest'),
    resolveAllJoinRequests: remote('resolveAllJoinRequests'),
    getChatInviteLinks: remote('getChatInviteLinks'),
    exportChatInviteLink: remote('exportChatInviteLink'),
    editChatInviteLink: remote('editChatInviteLink'),
    revokeChatInviteLink: remote('revokeChatInviteLink'),
    deleteChatInviteLink: remote('deleteChatInviteLink'),
    getChatManagement: remote('getChatManagement'),
    upgradeChat: remote('upgradeChat'),
    getAdminLog: remote('getAdminLog'),
    getSavedMessagesInfo: remote('getSavedMessagesInfo'),
    getSavedDialogs: remote('getSavedDialogs'),
    getSavedHistory: remote('getSavedHistory'),
    getEarlierGroupHistory: remote('getEarlierGroupHistory'),
    getSavedTags: remote('getSavedTags'),
    renameSavedTag: remote('renameSavedTag'),
    pinSavedDialog: remote('pinSavedDialog'),
    setSavedMessageTags: remote('setSavedMessageTags'),

    setChatSetting: remote('setChatSetting'),
    getManagedParticipants: remote('getManagedParticipants'),
    addChatMember: remote('addChatMember'),
    editChatParticipant: remote('editChatParticipant'),
    createChat: remote('createChat'),
    getChatFolders: remote('getChatFolders'),
    saveChatFolder: remote('saveChatFolder'),
    deleteChatFolder: remote('deleteChatFolder'),
    reorderChatFolders: remote('reorderChatFolders'),
    getFolderUpdates: remote('getFolderUpdates'),
    joinFolderUpdates: remote('joinFolderUpdates'),
    getFolderLinks: remote('getFolderLinks'),
    exportFolderLink: remote('exportFolderLink'),
    deleteFolderLink: remote('deleteFolderLink'),
    checkFolderInvite: remote('checkFolderInvite'),
    joinFolderInvite: remote('joinFolderInvite'),
    getPrivacy: remote('getPrivacy'),
    setPrivacy: remote('setPrivacy'),
    getReadTimePrivacy: remote('getReadTimePrivacy'),
    setReadTimePrivacy: remote('setReadTimePrivacy'),
    terminateSession: remote('terminateSession'),
    setSessionTtl: remote('setSessionTtl'),
    toggleReaction: remote('toggleReaction'),
    retryPendingSend: remote('retryPendingSend'),
    cancelPendingSend: remote('cancelPendingSend'),
    retryOutbox: remote('retryOutbox'),
    getLinkedMessage: remote('getLinkedMessage'),
    resolveUsername: remote('resolveUsername'),
    getDiscussion: remote('getDiscussion'),
    getReplies: remote('getReplies'),
    searchPeers: remote('searchPeers'),
    addPeer: remote('addPeer'),
    getUserDetails: remote('getUserDetails'),
    getGroupMembers: remote('getGroupMembers'),
    setUnreadMark: remote('setUnreadMark'),
    setMuted: remote('setMuted'),
    setBlocked: remote('setBlocked'),
    updateContact: remote('updateContact'),
    deleteContact: remote('deleteContact'),
    setPinnedDialog: remote('setPinnedDialog'),
    setPinnedMessage: remote('setPinnedMessage'),
    setArchived: remote('setArchived'),
    deleteDialog: remote('deleteDialog'),
    getWallpapers: remote('getWallpapers'),
    getChatAppearance: remote('getChatAppearance'),
    getRecentStickers: remote('getRecentStickers'),
    searchStickers: remote('searchStickers'),
    getFavoriteStickers: remote('getFavoriteStickers'),
    setStickerFavorite: remote('setStickerFavorite'),
    getStickerPacks: remote('getStickerPacks'),
    getStickerPack: remote('getStickerPack'),
    searchStickerPacks: remote('searchStickerPacks'),
    setStickerPackInstalled: remote('setStickerPackInstalled'),
    getSavedGifs: remote('getSavedGifs'),
    searchGifs: remote('searchGifs'),
    getBotCommands: remote('getBotCommands'),
    startBot: remote('startBot'),
    answerBotCallback: remote('answerBotCallback'),
    getBotApp: remote('getBotApp'),
    requestWebApp: remote('requestWebApp'),
    prolongWebApp: remote('prolongWebApp'),
    sendWebAppData: remote('sendWebAppData'),
    invokeWebAppMethod: remote('invokeWebAppMethod'),
    requestUrlAuth: remote('requestUrlAuth'),
    acceptUrlAuth: remote('acceptUrlAuth'),
  } satisfies EffectMessagingClient;
  const initialize = Effect.fn('TabCoordinator.initialize')(function* () {
    if (broadcastChannel) return;
    coordinationError = CHANNEL_ERROR;
    yield* setSnapshot({
      ...currentSnapshot(),
      phase: 'error',
      online: false,
      error: CHANNEL_ERROR,
    });
  });
  function handleInternalEvent(event: CoordinatorInternalEvent): Effect.Effect<void> {
    switch (event._tag) {
      case 'message':
        return receive(event.input);
      case 'snapshot':
        return publishSnapshot(event.snapshot);
      case 'resource':
        return Effect.all(
          [
            engineState.invalidateResource(event.event),
            Effect.sync(() =>
              post({
                type: 'resource',
                version: PROTOCOL_VERSION,
                from: thisClientId,
                event: event.event,
              }),
            ),
          ],
          { discard: true },
        );
      case 'conversation':
        return publishConversationEvent(event.event);
      case 'pagehide':
        return Effect.sync(() => announceClosing());
    }
  }
  function post(message: CoordinatorMessage) {
    if (!stopped) broadcastChannel?.postMessage(message);
  }
  function announceOwner() {
    ownerSeenAt = Date.now();
    post({ type: 'owner', version: PROTOCOL_VERSION, from: thisClientId, at: ownerSeenAt });
  }
  function announceClosing() {
    if (stopped) return;
    post({
      type: activeOwner ? 'owner-gone' : 'client-gone',
      version: PROTOCOL_VERSION,
      from: thisClientId,
    });
  }
  const receive = Effect.fn('TabCoordinator.receive')(function* (input: unknown) {
    const message = yield* decodeCoordinatorMessage(input).pipe(
      Effect.map((decoded) => decoded as CoordinatorMessage),
      Effect.catch((error) =>
        Effect.sync(() => {
          reportDiagnostic({
            code: 'invalid-tab-message',
            level: 'warn',
            area: 'coordination',
            message: 'Ignored an invalid cross-tab message.',
            details: { error: errorMessage(error) },
          });
        }),
      ),
    );
    if (!message) return;
    if (message.from === thisClientId || versionMismatch) return;
    if (message.version !== PROTOCOL_VERSION) {
      if (message.type === 'version-mismatch' && message.to === thisClientId) {
        yield* showVersionMismatch();
      } else if ('from' in message) {
        post({
          type: 'version-mismatch',
          version: PROTOCOL_VERSION,
          from: thisClientId,
          to: message.from,
        });
      }
      return;
    }
    switch (message.type) {
      case 'hello':
        if (activeOwner) {
          clientRegistry.touch(message.from);
          clientRegistry.setSnapshot(
            message.from,
            mergeAccountSnapshot(initialEngineSnapshot(), activeOwner.engine.snapshot()),
          );
          announceOwner();
          sendState(message.from);
        }
        break;
      case 'client-heartbeat':
        if (activeOwner) clientRegistry.touch(message.from);
        break;
      case 'owner':
        if (!activeOwner) {
          const previousOwnerId = activeOwnerId;
          const ownerChanged = previousOwnerId !== message.from;
          if (ownerChanged && previousOwnerId) {
            yield* rejectPendingSentTo(
              previousOwnerId,
              new Error('The active TeleVecha tab changed during the command.'),
            );
          }
          activeOwnerId = message.from;
          ownerSeenAt = Date.now();
          if (ownerChanged) {
            post({ type: 'hello', version: PROTOCOL_VERSION, from: thisClientId });
            const activePeerId = currentSnapshot().activePeerId;
            if (activePeerId) {
              yield* fork(
                invokeCoalesced('openConversation', [
                  activePeerId,
                  currentSnapshot().activeTopicId,
                  currentSnapshot().activeSavedPeer,
                ]).pipe(Effect.ignore),
              );
            }
          }
          yield* flushPendingRequests();
        }
        break;
      case 'owner-gone':
        if (activeOwnerId === message.from) {
          stateRevision += 1;
          activeOwnerId = undefined;
          yield* rejectPending(new Error('The active TeleVecha tab closed during the command.'));
          yield* markReconnecting();
          yield* fork(electOwner());
        }
        break;
      case 'client-gone':
        if (activeOwner) yield* removeClient(message.from);
        break;
      case 'state':
        if (message.to === thisClientId && message.from === activeOwnerId) {
          const revision = ++stateRevision;
          const respondingOwnerId = activeOwnerId;
          const snapshot = engineSnapshot(message.account, message.conversation);
          const incoming =
            !snapshot.activePeerId && currentSnapshot().activePeerId
              ? mergeAccountSnapshot(currentSnapshot(), snapshot)
              : snapshot;
          const hydration = coordinatorOptions.hydrateSnapshot?.(
            incoming,
            message.pendingPayloadIds ?? [],
          );
          yield* setSnapshot(incoming);
          if (hydration)
            yield* fork(
              hydration.pipe(
                Effect.flatMap((snapshot) =>
                  revision === stateRevision &&
                  respondingOwnerId === activeOwnerId &&
                  !activeOwner &&
                  !versionMismatch
                    ? setSnapshot(snapshot)
                    : Effect.void,
                ),
                Effect.ignore,
              ),
            );
        }
        break;
      case 'conversation-event':
        if (message.from === activeOwnerId)
          yield* engineState.publishConversationEvent(message.event);
        break;
      case 'resource':
        if (message.from === activeOwnerId) {
          yield* engineState.invalidateResource(message.event);
        }
        break;
      case 'request':
        if (activeOwner) {
          clientRegistry.touch(message.from);
          yield* queueRequest(message);
        }
        break;
      case 'response': {
        if (message.to !== thisClientId || message.from !== activeOwnerId) break;
        const pending = requestJournal.takePending(message.id);
        if (!pending) break;
        if (message.error)
          yield* Deferred.fail(pending.result, messagingErrorFromPayload(message.error));
        else yield* Deferred.succeed(pending.result, message.result);
        break;
      }
      case 'version-mismatch':
        if (message.to === thisClientId) yield* showVersionMismatch();
        break;
    }
  });
  const showVersionMismatch = Effect.fn('TabCoordinator.showVersionMismatch')(function* () {
    versionMismatch = true;
    stateRevision += 1;
    yield* setSnapshot({
      ...currentSnapshot(),
      phase: 'error',
      sync: 'stale',
      online: false,
      error: 'Reload to finish updating TeleVecha.',
      requiresReload: true,
    });
  });
  function subscribe(listener: (snapshot: EngineSnapshot) => void) {
    return engineState.subscribe(listener);
  }
  function subscribeResources(listener: (event: TelegramResourceInvalidation) => void) {
    return engineState.subscribeResources(listener);
  }
  function setSnapshot(snapshot: EngineSnapshot) {
    return engineState.set(snapshot);
  }
  function currentSnapshot() {
    return engineState.snapshotUnsafe();
  }
  const markReconnecting = Effect.fn('TabCoordinator.markReconnecting')(function* () {
    if (versionMismatch) return;
    yield* setSnapshot({
      ...currentSnapshot(),
      phase: currentSnapshot().dialogs.length > 0 ? 'ready' : 'connecting',
      sync: 'recovering',
      online: false,
      error: undefined,
    });
  });
  const start = Effect.fn('TabCoordinator.start')(function* (credentials: TelegramCredentials) {
    activeCredentials = credentials;
    if (!broadcastChannel) return;
    if (yield* coordinatorTasks.has('monitor')) return;
    stopped = false;
    yield* coordinatorTasks.repeat(
      'monitor',
      OWNER_HEARTBEAT_MS,
      Effect.gen(function* () {
        if (activeOwner) {
          clientRegistry.touch(thisClientId);
          const cutoff = Date.now() - OWNER_TIMEOUT_MS;
          for (const staleClientId of clientRegistry.staleClientIds(cutoff, thisClientId))
            yield* removeClient(staleClientId);
          return;
        }
        yield* maintainPendingRequests();
        if (activeOwnerId) {
          post({ type: 'client-heartbeat', version: PROTOCOL_VERSION, from: thisClientId });
        }
        if (!activeOwnerId) {
          activeOwnerId = undefined;
          yield* markReconnecting();
          yield* fork(electOwner());
        } else if (Date.now() - ownerSeenAt > OWNER_TIMEOUT_MS) {
          // A suspended tab delays both heartbeat timers. Ask Web Locks who owns
          // the lease before changing visible connection state.
          yield* fork(electOwner());
        }
      }),
    );
    yield* electOwner();
    if (!activeOwner) {
      post({ type: 'hello', version: PROTOCOL_VERSION, from: thisClientId });
    }
  });
  const electOwner = Effect.fn('TabCoordinator.electOwner')(function* () {
    const election = Effect.gen(function* () {
      if (activeOwner || stopped) return;
      if (!navigator.locks) {
        coordinationError = LOCKS_ERROR;
        yield* setSnapshot({
          ...currentSnapshot(),
          phase: 'error',
          online: false,
          error: LOCKS_ERROR,
        });
        yield* rejectPending(new Error(LOCKS_ERROR));
        return;
      }
      coordinationError = undefined;
      const lease = yield* acquireAvailableTabLease(
        `televecha-owner:${coordinatorOptions.key}`,
      ).pipe(Effect.mapError(() => new Error(LOCK_ACCESS_ERROR)));
      if (stopped) {
        if (lease) yield* lease.release;
        return;
      }
      if (lease) {
        const acquiredOwnerScope = yield* Scope.fork(rootScope, 'parallel');
        activeOwnerScope = acquiredOwnerScope;
        yield* Scope.addFinalizer(acquiredOwnerScope, lease.release);
        yield* Scope.provide(becomeOwner(), acquiredOwnerScope).pipe(
          Effect.catch(abandonFailedOwnership),
        );
      } else {
        post({ type: 'hello', version: PROTOCOL_VERSION, from: thisClientId });
      }
    });
    yield* coordinatorTasks.runExclusive('election', election).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          coordinationError = LOCK_ACCESS_ERROR;
          yield* setSnapshot({
            ...currentSnapshot(),
            phase: 'error',
            online: false,
            error: LOCK_ACCESS_ERROR,
          });
          yield* rejectPending(error instanceof Error ? error : new Error(errorMessage(error)));
        }),
      ),
    );
  });
  const becomeOwner = Effect.fn('TabCoordinator.becomeOwner')(function* () {
    const credentials = activeCredentials;
    if (!credentials) return;
    if (activeOwnerId && activeOwnerId !== thisClientId) {
      yield* rejectPendingSentTo(
        activeOwnerId,

        new Error('The previous TeleVecha tab stopped before confirming the command.'),
      );
    }
    activeOwnerId = thisClientId;
    stateRevision += 1;
    clientRegistry.touch(thisClientId);
    const createdOwner = yield* coordinatorOptions.createOwner();
    activeOwner = createdOwner;
    if (coordinatorOptions.ownerChanged) yield* coordinatorOptions.ownerChanged(createdOwner);
    clientRegistry.setSnapshot(thisClientId, currentSnapshot());
    resourceUnsubscribe = yield* createdOwner.engine.subscribeResources((event) => {
      Queue.offerUnsafe(eventQueue, { _tag: 'resource', event });
    });
    conversationUnsubscribe = yield* createdOwner.engine.subscribeConversationEvents((event) => {
      Queue.offerUnsafe(eventQueue, { _tag: 'conversation', event });
    });
    const starting = yield* Deferred.make<void, unknown>();
    ownerStarting = starting;
    ownerUnsubscribe = yield* createdOwner.engine.subscribe((snapshot) => {
      Queue.offerUnsafe(eventQueue, { _tag: 'snapshot', snapshot });
    });
    yield* coordinatorTasks.repeat(
      'heartbeat',
      OWNER_HEARTBEAT_MS,
      Effect.sync(() => announceOwner()),
    );
    announceOwner();
    yield* flushPendingRequests();
    yield* createdOwner.engine.start(credentials).pipe(
      Effect.tap(() => Deferred.succeed(starting, undefined)),
      Effect.tapError((error) => Deferred.fail(starting, error)),
      Effect.ensuring(
        Effect.sync(() => {
          if (ownerStarting === starting) ownerStarting = undefined;
        }),
      ),
    );
  });
  const abandonFailedOwnership = Effect.fn('TabCoordinator.abandonFailedOwnership')(function* (
    error: unknown,
  ) {
    yield* coordinatorTasks.cancel('heartbeat');
    if (ownerUnsubscribe) yield* ownerUnsubscribe;
    if (resourceUnsubscribe) yield* resourceUnsubscribe;
    if (conversationUnsubscribe) yield* conversationUnsubscribe;
    ownerUnsubscribe = undefined;
    resourceUnsubscribe = undefined;
    conversationUnsubscribe = undefined;
    const failedOwner = activeOwner;
    activeOwner = undefined;
    ownerStarting = undefined;
    activeOwnerId = undefined;
    if (failedOwner) yield* failedOwner.engine.stop().pipe(Effect.ignore);
    const failedOwnerScope = activeOwnerScope;
    activeOwnerScope = undefined;
    if (failedOwnerScope) yield* Scope.close(failedOwnerScope, Exit.void);
    if (failedOwner && coordinatorOptions.ownerChanged) {
      yield* coordinatorOptions.ownerChanged(undefined).pipe(Effect.ignore);
    }
    yield* setSnapshot({
      ...currentSnapshot(),
      phase: 'error',
      sync: 'stale',
      online: false,
      error: `Could not start the active TeleVecha tab. ${errorMessage(error)}`,
    });
  });
  const publishConversationEvent = Effect.fn('TabCoordinator.publishConversationEvent')(function* (
    event: TelegramConversationEvent,
  ) {
    yield* engineState.publishConversationEvent(event);
    post({ type: 'conversation-event', version: PROTOCOL_VERSION, from: thisClientId, event });
    if (event.type === 'history-reset') {
      yield* reloadClientConversationViews(event.peerId);
      return;
    }
    clientRegistry.recordConversationChange(event);
    for (const [clientId, previous] of clientRegistry.snapshots()) {
      const next = shareEqualSnapshotFields(previous, applyConversationChange(previous, event));
      if (next === previous) continue;
      clientRegistry.setSnapshot(clientId, next);
      if (clientId === thisClientId) yield* setSnapshot(next);
      else yield* queueState(clientId);
    }
  });
  const topicReadMax = new Map<string, number>();
  const loadSavedView = Effect.fn('TabCoordinator.loadSavedView')(function* (
    engine: NonNullable<typeof activeOwner>['engine'],
    peerId: string,
    savedPeer: TelegramPeer,
    previous?: ConversationViewSnapshot,
    before?: number,
  ): Effect.fn.Return<ConversationViewSnapshot, unknown> {
    const page = yield* engine.getSavedHistory(savedPeer, before);
    if (page.messages.some((message) => message.peerId !== peerId))
      return yield* Effect.fail(new Error('Saved Messages belong to another account.'));
    const messages = [
      ...new Map(
        [...(previous?.messages ?? []), ...page.messages]
          .filter((message) => messageInSavedDialog(message, savedPeer.id))
          .map((message) => [message.id, message]),
      ).values(),
    ].sort((a, b) => a.id - b.id);
    return {
      activePeerId: peerId,
      activeSavedPeer: savedPeer,
      messages,
      loadingMessages: false,
      loadingOlderMessages: false,
      hasOlderMessages: page.hasOlder,
      pinnedMessages: messages.filter((message) => message.pinned),
      historyGaps: [],
    };
  });
  const loadTopicView = Effect.fn('TabCoordinator.loadTopicView')(function* (
    engine: NonNullable<typeof activeOwner>['engine'],
    peerId: string,
    topicId: number,
    previous?: ConversationViewSnapshot,
    before?: number,
  ): Effect.fn.Return<ConversationViewSnapshot, unknown> {
    const peer = engine.snapshot().dialogs.find((dialog) => dialog.peer.id === peerId)?.peer;
    if (!peer) return yield* Effect.fail(new Error('This forum is no longer available.'));
    const page = yield* engine.getReplies(peer, topicId, before);
    const combined = [...(previous?.messages ?? []), ...page.messages].filter((message) =>
      messageInTopic(message, topicId),
    );
    const messages = [...new Map(combined.map((message) => [message.id, message])).values()].sort(
      (a, b) => a.id - b.id,
    );
    return {
      activePeerId: peerId,
      activeTopicId: topicId,
      sharedMediaCounts: undefined,
      messages,
      loadingMessages: false,
      loadingOlderMessages: false,
      hasOlderMessages: page.hasOlder,
      pinnedMessages: messages.filter((message) => message.pinned),
      historyGaps: [],
    };
  });
  const refreshClientConversationMetadata = Effect.fn(
    'TabCoordinator.refreshClientConversationMetadata',
  )(function* (
    clientId: string,
    peerId: string,
    engine: NonNullable<typeof activeOwner>['engine'],
  ) {
    if (
      clientRegistry.snapshot(clientId)?.activeTopicId !== undefined ||
      clientRegistry.snapshot(clientId)?.activeSavedPeer
    )
      return;
    // Pins publish conversation events as cached and remote values arrive. Those
    // events also enter any pending history load's journal.
    yield* fork(engine.loadConversationPinnedMessages(peerId).pipe(Effect.ignore));
    yield* fork(
      engine.loadConversationSharedMediaCounts(peerId).pipe(
        Effect.flatMap((sharedMediaCounts) => {
          const current = clientRegistry.snapshot(clientId);
          if (
            sharedMediaCounts === undefined ||
            current?.activePeerId !== peerId ||
            current.activeTopicId !== undefined ||
            current.activeSavedPeer !== undefined ||
            activeOwner?.engine !== engine
          )
            return Effect.void;
          return publishClientSnapshot(clientId, { ...current, sharedMediaCounts });
        }),
        Effect.ignore,
      ),
    );
  });
  const reloadClientConversationViews = Effect.fn('TabCoordinator.reloadClientConversationViews')(
    function* (onlyPeerId?: string) {
      const engine = activeOwner?.engine;
      if (!engine) return;
      for (const [clientId, previous] of clientRegistry.snapshots()) {
        const peerId = previous.activePeerId;
        if (!peerId || previous.loadingMessages || (onlyPeerId && peerId !== onlyPeerId)) {
          continue;
        }
        if (previous.messages.length === 0) {
          yield* publishClientSnapshot(clientId, {
            ...previous,
            loadingMessages: true,
            loadingOlderMessages: false,
          });
        }
        const request = clientRegistry.beginConversationLoad(clientId, peerId);
        yield* refreshClientConversationMetadata(clientId, peerId, engine);
        yield* fork(
          (previous.activeSavedPeer
            ? loadSavedView(engine, peerId, previous.activeSavedPeer)
            : previous.activeTopicId !== undefined
              ? loadTopicView(engine, peerId, previous.activeTopicId)
              : engine.loadConversationView(peerId)
          ).pipe(
            Effect.matchEffect({
              onSuccess: (conversation) =>
                Effect.suspend(() => {
                  const current = clientRegistry.snapshot(clientId);
                  if (!request.current() || !current || activeOwner?.engine !== engine)
                    return Effect.void;
                  const next = request.complete({
                    ...conversation,
                    pinnedMessages: current.pinnedMessages,
                    ...(current.sharedMediaCounts !== undefined
                      ? { sharedMediaCounts: current.sharedMediaCounts }
                      : {}),
                  });
                  return next
                    ? publishClientSnapshot(
                        clientId,
                        engineSnapshot(accountSnapshot(engine.snapshot()), next),
                      )
                    : Effect.void;
                }),
              onFailure: (error) =>
                Effect.suspend(() => {
                  const current = clientRegistry.snapshot(clientId);
                  if (!request.current() || !current || activeOwner?.engine !== engine)
                    return Effect.void;
                  request.cancel();
                  return publishClientSnapshot(clientId, {
                    ...current,
                    loadingMessages: false,
                    historyError: `Could not reload this conversation. ${errorMessage(error)}`,
                  });
                }),
            }),
            Effect.ensuring(Effect.sync(() => request.cancel())),
          ),
        );
      }
    },
  );
  const publishSnapshot = Effect.fn('TabCoordinator.publishSnapshot')(function* (
    snapshot: AccountSnapshot,
  ) {
    if (!activeOwner) return;
    if (!clientRegistry.hasSnapshot(thisClientId)) {
      clientRegistry.setSnapshot(thisClientId, initialEngineSnapshot());
    }
    let reloadAfterReconnect = false;
    for (const [clientId, previous] of clientRegistry.snapshots()) {
      const source = ownerStarting ? retainWorkspaceWhileStarting(previous, snapshot) : snapshot;
      const account = mergeAccountSnapshot(previous, source);
      const activePeerId = previous.activePeerId;
      const candidate =
        activePeerId && !source.dialogs.some(({ peer }) => peer.id === activePeerId)
          ? engineSnapshot(
              accountSnapshot(account),
              conversationViewSnapshot(initialEngineSnapshot()),
            )
          : account;
      const next = shareEqualSnapshotFields(previous, candidate);
      if (
        activePeerId &&
        source.online &&
        source.sync === 'current' &&
        (!previous.online || previous.sync !== 'current')
      ) {
        reloadAfterReconnect = true;
      }
      if (next === previous) continue;
      clientRegistry.setSnapshot(clientId, next);
      if (clientId === thisClientId) yield* setSnapshot(next);
      else yield* queueState(clientId);
    }
    if (reloadAfterReconnect) yield* reloadClientConversationViews();
    for (const peerId of clientRegistry.visiblePeerIds()) yield* fork(applyVisibility(peerId));
  });
  function sendState(clientId: string) {
    const snapshot = clientRegistry.snapshot(clientId);
    if (!snapshot) return;
    post({
      type: 'state',
      version: PROTOCOL_VERSION,
      from: thisClientId,
      to: clientId,
      account: accountSnapshot(transferableSnapshot(snapshot)),
      conversation: conversationViewSnapshot(snapshot),
      pendingPayloadIds: pendingPayloadIds(snapshot),
    });
  }
  function queueState(clientId: string) {
    clientRegistry.queueState(clientId);
    return coordinatorTasks.delay(
      'state',
      16,
      Effect.sync(() => {
        for (const queuedClientId of clientRegistry.takeQueuedStateClients()) {
          sendState(queuedClientId);
        }
      }),
      { onlyIfMissing: true },
    );
  }
  const queueRequest = Effect.fn('TabCoordinator.queueRequest')(function* (
    request: Extract<CoordinatorMessage, { type: 'request' }>,
  ) {
    const requestKey = `${request.from}:${request.id}`;
    const completed = requestJournal.completed(requestKey);
    if (completed) {
      post({
        type: 'response',
        version: PROTOCOL_VERSION,
        from: thisClientId,
        to: request.from,
        id: request.id,
        ...completed,
      });
      return;
    }
    if (!requestJournal.begin(requestKey)) return;
    if (commandPolicies[request.method].concurrent) {
      yield* fork(
        handleRequest(request, requestKey).pipe(
          Effect.ensuring(Effect.sync(() => requestJournal.finish(requestKey))),
          Effect.ignore,
        ),
      );
      return;
    }
    yield* fork(
      coordinatorTasks
        .serialize(handleRequest(request, requestKey))
        .pipe(Effect.ensuring(Effect.sync(() => requestJournal.finish(requestKey))), Effect.ignore),
    );
  });
  const handleRequest = Effect.fn('TabCoordinator.handleRequest')(function* (
    request: Extract<CoordinatorMessage, { type: 'request' }>,
    requestKey: string,
  ) {
    yield* Effect.gen(function* () {
      const result = yield* invokeOwner(request.from, request.method, request.args);
      requestJournal.remember(requestKey, { result });
      post({
        type: 'response',
        version: PROTOCOL_VERSION,
        from: thisClientId,
        to: request.from,
        id: request.id,
        result,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          const completed = { error: messagingErrorPayload(error, request.method) };
          requestJournal.remember(requestKey, completed);
          post({
            type: 'response',
            version: PROTOCOL_VERSION,
            from: thisClientId,
            to: request.from,
            id: request.id,
            ...completed,
          });
        }),
      ),
    );
  });
  function removeClient(clientId: string) {
    const peerId = clientRegistry.remove(clientId);
    return peerId ? applyVisibility(peerId) : Effect.void;
  }
  function publishClientSnapshot(clientId: string, snapshot: EngineSnapshot) {
    const previous = clientRegistry.snapshot(clientId);
    const next = previous ? shareEqualSnapshotFields(previous, snapshot) : snapshot;
    if (next === previous) return Effect.void;
    clientRegistry.setSnapshot(clientId, next);
    if (clientId === thisClientId) return setSnapshot(next);
    sendState(clientId);
    return Effect.void;
  }
  const updateClientConversation = Effect.fn('TabCoordinator.updateClientConversation')(function* (
    clientId: string,
    peerId: string,
    loading: ConversationViewSnapshot,
    load: () => Effect.Effect<ConversationViewSnapshot, unknown>,
  ) {
    const engine = activeOwner?.engine;
    if (!engine) {
      return yield* Effect.fail(new Error('TeleVecha is reconnecting in another tab.'));
    }
    const request = clientRegistry.beginConversationLoad(clientId, peerId);
    return yield* Effect.gen(function* () {
      yield* publishClientSnapshot(
        clientId,
        engineSnapshot(accountSnapshot(engine.snapshot()), loading),
      );
      const conversation = yield* load();
      const current = clientRegistry.snapshot(clientId);
      const next =
        request.current() && activeOwner?.engine === engine
          ? request.complete(retainConversationMetadata(current, conversation))
          : undefined;
      if (next)
        yield* publishClientSnapshot(
          clientId,
          engineSnapshot(accountSnapshot(engine.snapshot()), next),
        );
      else request.cancel();
      return { conversation: next ?? conversation, current: request.current };
    }).pipe(Effect.onError(() => Effect.sync(() => request.cancel())));
  });
  const invokeOwner = Effect.fn('TabCoordinator.invokeOwner')(function* (
    clientId: string,
    method: RemoteMethod,
    args: unknown[],
  ) {
    const owner = activeOwner;
    if (!owner) {
      return yield* Effect.fail(new Error('TeleVecha is reconnecting in another tab.'));
    }
    const engine = owner.engine;
    if (commandPolicies[method].readiness === 'workspace') {
      yield* engine.whenCommandReady();
    } else if (commandPolicies[method].readiness === 'startup') {
      if (ownerStarting) yield* Deferred.await(ownerStarting);
    } else {
      yield* engine.whenAccountReady();
    }
    if (activeOwner !== owner) {
      return yield* Effect.fail(new Error('The active TeleVecha tab changed during the command.'));
    }
    if (method === 'openConversation') {
      const peerId = String(args[0]);
      const previous = clientRegistry.snapshot(clientId);
      const topicId = typeof args[1] === 'number' ? args[1] : undefined;
      const savedPeer = args[2] as TelegramPeer | undefined;
      if (savedPeer && topicId !== undefined)
        return yield* Effect.fail(new Error('Choose a topic or a saved chat.'));
      const request = yield* updateClientConversation(
        clientId,
        peerId,
        conversationLoadingSnapshot(previous, peerId, topicId, savedPeer),
        () =>
          savedPeer
            ? loadSavedView(engine, peerId, savedPeer)
            : topicId === undefined
              ? engine.loadConversationView(peerId)
              : loadTopicView(engine, peerId, topicId),
      );
      if (!request.current() || activeOwner?.engine !== engine) return true;
      yield* refreshClientConversationMetadata(clientId, peerId, engine);
      yield* fork(applyVisibility(peerId).pipe(Effect.ignore));
      return true;
    }
    if (method === 'setActiveConversationVisibility') {
      const peerId = String(args[0]);
      const state = args[1] as { visible: boolean; atBottom: boolean };
      const view = clientRegistry.snapshot(clientId);
      if (view?.activeSavedPeer) {
        clientRegistry.setVisibility(clientId, { peerId, visible: false, atBottom: false });
        yield* applyVisibility(peerId);
        return;
      }
      if (view?.activeTopicId !== undefined) {
        clientRegistry.setVisibility(clientId, { peerId, visible: false, atBottom: false });
        yield* applyVisibility(peerId);
        const peer = engine.snapshot().dialogs.find((dialog) => dialog.peer.id === peerId)?.peer;
        const maxId = view.messages.at(-1)?.id ?? 0;
        const key = `${clientId}:${peerId}:${view.activeTopicId}`;
        if (peer && state.visible && state.atBottom && maxId > (topicReadMax.get(key) ?? 0)) {
          yield* engine.readForumTopic(peer, view.activeTopicId, maxId);
          topicReadMax.set(key, maxId);
        }
        return;
      }
      clientRegistry.setVisibility(clientId, { peerId, ...state });
      yield* applyVisibility(peerId);
      return;
    }
    if (method === 'openMessageInConversationView') {
      const message = args[0] as TelegramMessage;
      const peerId = message.peerId;
      const previous = clientRegistry.snapshot(clientId) ?? initialEngineSnapshot();
      if (previous.activePeerId !== peerId) {
        return yield* Effect.fail(
          new Error('This conversation view was superseded by a newer selection.'),
        );
      }
      let found = false;
      const { conversation } = yield* updateClientConversation(
        clientId,
        peerId,
        conversationViewSnapshot(previous),
        () =>
          Effect.gen(function* () {
            if (previous.activeSavedPeer) {
              if (!messageInSavedDialog(message, previous.activeSavedPeer.id))
                return yield* Effect.fail(new Error('The message belongs to another saved chat.'));
              const view = yield* loadSavedView(
                engine,
                peerId,
                previous.activeSavedPeer,
                undefined,
                message.id + 1,
              );
              found = view.messages.some((item) => item.id === message.id);
              return view;
            }
            if (previous.activeTopicId !== undefined) {
              const view = yield* loadTopicView(
                engine,
                peerId,
                previous.activeTopicId,
                undefined,
                message.id + 1,
              );
              found = view.messages.some((item) => item.id === message.id);
              return view;
            }
            const result = yield* engine.openMessageInConversationView(
              message,
              conversationViewSnapshot(previous),
            );
            found = result.found;
            return result.conversation;
          }),
      );
      return { conversation, found };
    }
    if (method === 'loadConversationSharedMediaCounts') {
      const peerId = String(args[0]);
      const previous = clientRegistry.snapshot(clientId) ?? initialEngineSnapshot();
      if (
        previous.activePeerId !== peerId ||
        previous.activeSavedPeer ||
        previous.activeTopicId !== undefined
      )
        return undefined;
      const counts = yield* engine.loadConversationSharedMediaCounts(peerId);
      const current = clientRegistry.snapshot(clientId);
      if (
        counts &&
        current?.activePeerId === peerId &&
        !current.activeSavedPeer &&
        current.activeTopicId === undefined
      ) {
        yield* publishClientSnapshot(clientId, { ...current, sharedMediaCounts: counts });
      }
      return counts;
    }
    if (
      method === 'loadOlderConversationView' ||
      method === 'loadHistoryGapConversationView' ||
      method === 'retryConversationView'
    ) {
      const peerId = String(args[0]);
      const previous = clientRegistry.snapshot(clientId) ?? initialEngineSnapshot();
      if (previous.activePeerId !== peerId) {
        return yield* Effect.fail(
          new Error('This conversation view was superseded by a newer selection.'),
        );
      }
      const { conversation } = yield* updateClientConversation(
        clientId,
        peerId,
        {
          ...conversationViewSnapshot(previous),
          ...(method === 'retryConversationView' && previous.messages.length === 0
            ? { loadingMessages: true }
            : { loadingOlderMessages: true }),
        },
        () =>
          previous.activeSavedPeer
            ? loadSavedView(
                engine,
                peerId,
                previous.activeSavedPeer,
                method === 'loadOlderConversationView' ? previous : undefined,
                method === 'loadOlderConversationView' ? previous.messages[0]?.id : undefined,
              )
            : previous.activeTopicId !== undefined
              ? loadTopicView(
                  engine,
                  peerId,
                  previous.activeTopicId,
                  method === 'loadOlderConversationView' ? previous : undefined,
                  method === 'loadOlderConversationView' ? previous.messages[0]?.id : undefined,
                )
              : method === 'loadOlderConversationView'
                ? engine.loadOlderConversationView(peerId, conversationViewSnapshot(previous))
                : method === 'loadHistoryGapConversationView'
                  ? engine.loadHistoryGapConversationView(
                      peerId,
                      args[1] as TelegramHistoryGap,
                      conversationViewSnapshot(previous),
                    )
                  : engine.retryConversationView(peerId, conversationViewSnapshot(previous)),
      );
      return conversation;
    }
    if (method === 'logOut') topicReadMax.clear();
    const result = yield* invokeEngineCommand(engine, method, args);
    const next = engine.snapshot();
    const previous = clientRegistry.snapshot(clientId) ?? initialEngineSnapshot();
    const merged = mergeAccountSnapshot(previous, next);
    clientRegistry.setSnapshot(clientId, merged);
    if (clientId === thisClientId) yield* setSnapshot(merged);
    else sendState(clientId);
    return result;
  });
  const applyVisibility = Effect.fn('TabCoordinator.applyVisibility')(function* (peerId: string) {
    const engine = activeOwner?.engine;
    if (!engine) return;
    const cutoff = Date.now() - OWNER_TIMEOUT_MS;
    const reports = clientRegistry.visibilityReports(peerId, cutoff);
    const visible = reports.some((report) => report.visible);
    const atBottom = reports.some((report) => report.visible && report.atBottom);
    yield* engine.setActiveConversationVisibility(peerId, { visible, atBottom });
  });
  const invoke = Effect.fn('TabCoordinator.invoke')(function* (
    method: RemoteMethod,
    args: unknown[],
  ) {
    if (stopped) return yield* Effect.fail(new Error('This tab is no longer connected.'));
    if (versionMismatch) {
      return yield* Effect.fail(new Error('Reload to finish updating TeleVecha.'));
    }
    if (coordinationError) return yield* Effect.fail(new Error(coordinationError));
    if (activeOwner) return yield* callOwner(method, args);
    if (!activeOwnerId) {
      yield* markReconnecting();
      yield* fork(electOwner());
    } else if (Date.now() - ownerSeenAt > OWNER_TIMEOUT_MS) {
      yield* fork(electOwner());
    }
    const id = crypto.randomUUID();
    const result = yield* Deferred.make<unknown, Error>();
    const request = { id, method, args, createdAt: Date.now(), result };
    requestJournal.add(request);
    yield* dispatchPendingRequest(request);
    return yield* Deferred.await(result);
  });
  function callOwner(method: RemoteMethod, args: unknown[]) {
    if (commandPolicies[method].concurrent) return invokeOwner(thisClientId, method, args);
    return coordinatorTasks.serialize(invokeOwner(thisClientId, method, args));
  }
  const dispatchPendingRequest = Effect.fn('TabCoordinator.dispatchPendingRequest')(function* (
    request: PendingRequest<RemoteMethod>,
    retry: boolean = false,
  ) {
    if (!requestJournal.hasPending(request.id) || (request.sentTo && !retry)) return;
    if (activeOwner) {
      request.sentTo = thisClientId;
      yield* callOwner(request.method, request.args).pipe(
        Effect.matchEffect({
          onSuccess: (value) =>
            requestJournal.takePending(request.id)
              ? Deferred.succeed(request.result, value).pipe(Effect.asVoid)
              : Effect.void,
          onFailure: (error) =>
            requestJournal.takePending(request.id)
              ? Deferred.fail(
                  request.result,
                  error instanceof Error ? error : new Error(String(error)),
                ).pipe(Effect.asVoid)
              : Effect.void,
        }),
      );
      return;
    }
    if (!activeOwnerId) return;
    request.sentTo = activeOwnerId;
    request.sentAt = Date.now();
    yield* Effect.sync(() => {
      post({
        type: 'request',
        version: PROTOCOL_VERSION,
        from: thisClientId,
        id: request.id,
        method: request.method,
        args: request.args,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (requestJournal.takePending(request.id)) {
            yield* Deferred.fail(request.result, new Error(errorMessage(error)));
          }
        }),
      ),
    );
  });
  function flushPendingRequests() {
    return Effect.forEach(
      [...requestJournal.pendingValues()],
      (request) => dispatchPendingRequest(request),
      { discard: true },
    );
  }
  const maintainPendingRequests = Effect.fn('TabCoordinator.maintainPendingRequests')(function* (
    now: number = Date.now(),
  ) {
    for (const [id, request] of requestJournal.pendingEntries()) {
      if (now - request.createdAt >= REQUEST_TIMEOUT_MS) {
        if (requestJournal.takePending(id)) {
          yield* Deferred.fail(
            request.result,
            new Error('The active TeleVecha tab did not confirm the command in time.'),
          );
        }
        continue;
      }
      if (!request.sentTo) {
        yield* dispatchPendingRequest(request);
        continue;
      }
      if (
        request.sentTo === activeOwnerId &&
        request.sentAt !== undefined &&
        now - request.sentAt >= REQUEST_RETRY_MS
      ) {
        yield* dispatchPendingRequest(request, true);
      }
    }
  });
  function invokeCoalesced(method: RemoteMethod, args: unknown[]) {
    const key = `${method}:${JSON.stringify(args)}`;
    return coalescedRequests.load(key, () => invoke(method, args));
  }
  function surfaceCommandFailure<Value, Error, Requirements>(
    operation: Effect.Effect<Value, Error, Requirements>,
  ) {
    return operation.pipe(
      Effect.tapError((error) =>
        !stopped
          ? setSnapshot({ ...currentSnapshot(), operationError: errorMessage(error) })
          : Effect.void,
      ),
    );
  }
  function rejectPending(error: Error) {
    return requestJournal.rejectAll(error);
  }
  function rejectPendingSentTo(ownerId: string, error: Error) {
    return requestJournal.rejectPending((request) => request.sentTo === ownerId, error);
  }
  const openConversation = Effect.fn('TabCoordinator.openConversation')(function* (
    peerId: string,
    topicId?: number,
    savedPeer?: TelegramPeer,
  ) {
    yield* invokeCoalesced('openConversation', [peerId, topicId, savedPeer]);
    const selectedConversation = conversation(peerId, topicId, savedPeer);
    if (!selectedConversation) {
      return yield* Effect.fail(new Error('The requested conversation is no longer available.'));
    }
    return selectedConversation;
  });
  function conversation(peerId: string, topicId?: number, savedPeer?: TelegramPeer) {
    const dialog = currentSnapshot().dialogs.find(({ peer }) => peer.id === peerId);
    return dialog ? makeConversation(client, dialog.peer, topicId, savedPeer) : undefined;
  }
  function mediaAssetKey(message: TelegramMessage) {
    return telegramMediaAssetKey(message);
  }
  const stop = Effect.fn('TabCoordinator.stop')(function* () {
    if (stopped) return;
    announceClosing();
    stopped = true;
    yield* coordinatorTasks.clear;
    yield* rejectPending(new Error('This tab closed before the command completed.'));
    yield* coalescedRequests.clear;
    requestJournal.clearOwnerRecords();
    clientRegistry.clear();
    yield* Effect.gen(function* () {
      const stoppingOwner = activeOwner;
      if (stoppingOwner) {
        if (ownerUnsubscribe) yield* ownerUnsubscribe;
        if (resourceUnsubscribe) yield* resourceUnsubscribe;
        if (conversationUnsubscribe) yield* conversationUnsubscribe;
        ownerUnsubscribe = undefined;
        resourceUnsubscribe = undefined;
        conversationUnsubscribe = undefined;
        yield* stoppingOwner.engine.stop().pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              activeOwner = undefined;
              ownerStarting = undefined;
              const stoppingOwnerScope = activeOwnerScope;
              activeOwnerScope = undefined;
              if (stoppingOwnerScope) yield* Scope.close(stoppingOwnerScope, Exit.void);
              if (coordinatorOptions.ownerChanged)
                yield* coordinatorOptions.ownerChanged(undefined);
            }),
          ),
        );
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          broadcastChannel?.close();
        }),
      ),
    );
  });
  return {
    client: client,
    initialize: initialize,
    handleInternalEvent: handleInternalEvent,
    receive: receive,
    start: start,
    stop: stop,
  };
}
export type TabCoordinator = ReturnType<typeof makeTabCoordinatorModule>;

export const makeTabCoordinator = Effect.fn('TabCoordinator.make')(function* (
  options: TabCoordinatorOptions,
) {
  const state = yield* EngineState;
  const tasks = yield* CoordinatorTasks;
  const rootScope = yield* Scope.Scope;
  const coalescedOperations = yield* makeResourceCache();
  const fork = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.forkIn(effect, rootScope);
  const events = yield* Queue.unbounded<CoordinatorInternalEvent>();
  const channel = yield* Effect.try({
    try: () =>
      typeof BroadcastChannel === 'undefined'
        ? undefined
        : new BroadcastChannel(`televecha:${options.key}`),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));
  const coordinator = makeTabCoordinatorModule(
    options,
    state,
    tasks,
    events,
    channel,
    rootScope,
    coalescedOperations,
  );
  const onMessage = (event: MessageEvent<unknown>) => {
    Queue.offerUnsafe(events, { _tag: 'message', input: event.data });
  };
  const onPageHide = () => {
    Queue.offerUnsafe(events, { _tag: 'pagehide' });
  };
  channel?.addEventListener('message', onMessage);
  window.addEventListener('pagehide', onPageHide);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      channel?.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', onPageHide);
      yield* coordinator.stop().pipe(Effect.ignore);
    }),
  );
  yield* fork(
    Stream.fromQueue(events).pipe(
      Stream.runForEach((event) => coordinator.handleInternalEvent(event).pipe(Effect.ignore)),
    ),
  );
  yield* coordinator.initialize();
  return coordinator;
});
