import type { MessagingEngine } from './engine';
import type { EffectConversation } from './conversation';
import type { TelegramPeer, EngineSnapshot } from '../types';
import type { Effect } from 'effect';
import type { MessagingError } from './messagingError';

export { MessagingError } from './messagingError';

export const messagingCapabilities = [
  'snapshot',
  'subscribe',
  'subscribeResources',
  'subscribeConversationEvents',
  'start',
  'stop',
  'retrySync',
  'refreshUpdates',
  'refreshReadReceipt',
  'retryMarkRead',
  'markMediaRead',
  'getUnreadNotifications',
  'markMessageNotificationsRead',
  'markAllNotificationsRead',
  'clearOperationError',
  'beginQrLogin',
  'cancelQrLogin',
  'requestCode',
  'submitCode',
  'submitPassword',
  'logOut',
  'clearCache',
  'conversation',
  'openConversation',
  'loadConversationSharedMediaCounts',
  'loadOlderConversationView',
  'loadHistoryGapConversationView',
  'retryConversationView',
  'openMessageInConversationView',
  'searchConversationMessages',
  'getConversationSharedMedia',
  'setActiveConversationVisibility',
  'setDraft',
  'setTyping',
  'sendDraft',
  'sendAttachments',
  'sendSticker',
  'sendContact',
  'sendPoll',
  'updatePoll',
  'forwardMessage',
  'editMessage',
  'deleteMessage',
  'toggleReaction',
  'getReactionPeople',
  'getMessageReadReceipts',
  'getPollVotes',
  'getActiveSessions',
  'deleteForumTopic',
  'getForumTopic',
  'getForumTopics',
  'createForumTopic',
  'editForumTopic',
  'pinForumTopic',
  'readForumTopic',
  'getJoinRequests',
  'resolveJoinRequest',
  'resolveAllJoinRequests',
  'getChatInviteLinks',
  'exportChatInviteLink',
  'editChatInviteLink',
  'revokeChatInviteLink',
  'deleteChatInviteLink',
  'getChatManagement',
  'upgradeChat',
  'getAdminLog',
  'getSavedMessagesInfo',
  'getSavedDialogs',
  'getSavedHistory',
  'getEarlierGroupHistory',
  'getSavedTags',
  'renameSavedTag',
  'pinSavedDialog',
  'setSavedMessageTags',

  'setChatSetting',
  'getManagedParticipants',
  'addChatMember',
  'editChatParticipant',
  'createChat',
  'checkChatInvite',
  'joinChatInvite',
  'getChatFolders',
  'saveChatFolder',
  'deleteChatFolder',
  'reorderChatFolders',
  'getFolderUpdates',
  'joinFolderUpdates',
  'getFolderLinks',
  'exportFolderLink',
  'deleteFolderLink',
  'checkFolderInvite',
  'joinFolderInvite',
  'getPrivacy',
  'setPrivacy',
  'getReadTimePrivacy',
  'setReadTimePrivacy',
  'terminateSession',
  'setSessionTtl',
  'retryPendingSend',
  'cancelPendingSend',
  'retryOutbox',
  'getLinkedMessage',
  'resolveUsername',
  'getDiscussion',
  'getReplies',
  'searchPeers',
  'addPeer',
  'getUserDetails',
  'getGroupMembers',
  'setUnreadMark',
  'setMuted',
  'setBlocked',
  'updateContact',
  'deleteContact',
  'setPinnedDialog',
  'setPinnedMessage',
  'setArchived',
  'deleteDialog',
  'getWallpapers',
  'getChatAppearance',
  'downloadWallpaper',
  'getRecentStickers',
  'searchStickers',
  'getFavoriteStickers',
  'setStickerFavorite',
  'getStickerPacks',
  'getStickerPack',
  'searchStickerPacks',
  'setStickerPackInstalled',
  'getSavedGifs',
  'searchGifs',
  'getBotApp',
  'requestWebApp',
  'prolongWebApp',
  'sendWebAppData',
  'invokeWebAppMethod',
  'getBotCommands',
  'startBot',
  'answerBotCallback',
  'requestUrlAuth',
  'acceptUrlAuth',
  'loadCachedAvatar',
  'downloadAvatar',
  'mediaAssetKey',
  'downloadMedia',
  'downloadSticker',
  'downloadCustomEmoji',
] as const;

type MessagingCapability = (typeof messagingCapabilities)[number];
type FacadeCapability = 'conversation' | 'openConversation' | 'snapshot' | 'subscribe';
type EngineCapability = Exclude<MessagingCapability, FacadeCapability>;

type ClientCapability<Capability> = Capability extends (
  ...args: infer Arguments
) => Effect.Effect<infer Success, infer _Error, infer Requirements>
  ? (...args: Arguments) => Effect.Effect<Success, MessagingError, Requirements>
  : Capability;

type EffectEngineClient = {
  readonly [Capability in EngineCapability]: ClientCapability<MessagingEngine[Capability]>;
};

/**
 * The closed messaging capability set consumed by the UI. Engine-only lifecycle,
 * synchronization, and compatibility methods cannot leak into cross-tab RPC.
 */
export type EffectMessagingClient = EffectEngineClient & {
  snapshot(): EngineSnapshot;
  subscribe(listener: (snapshot: EngineSnapshot) => void): Effect.Effect<Effect.Effect<void>>;
  conversation(
    peerId: string,
    topicId?: number,
    savedPeer?: TelegramPeer,
  ): EffectConversation | undefined;
  openConversation(
    peerId: string,
    topicId?: number,
    savedPeer?: TelegramPeer,
  ): Effect.Effect<EffectConversation, MessagingError>;
};

const _capabilitiesMatchClient: readonly (keyof EffectMessagingClient)[] = messagingCapabilities;
void _capabilitiesMatchClient;
