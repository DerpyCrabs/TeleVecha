import type { MessagingEngine } from './engine';
import type { EffectConversation } from './conversation';
import type { EngineSnapshot } from '../types';
import type { Effect } from 'effect';
import type { MessagingError } from './messagingError';

export { MessagingError } from './messagingError';

export const messagingCapabilities = [
  'snapshot',
  'subscribe',
  'subscribeResources',
  'start',
  'stop',
  'retrySync',
  'refreshUpdates',
  'refreshReadReceipt',
  'retryMarkRead',
  'markMediaRead',
  'clearOperationError',
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
  'forwardMessage',
  'editMessage',
  'deleteMessage',
  'toggleReaction',
  'getReactionPeople',
  'retryPendingSend',
  'cancelPendingSend',
  'retryOutbox',
  'searchPeers',
  'addPeer',
  'getUserDetails',
  'getGroupMembers',
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
  'getStickerPacks',
  'getSavedGifs',
  'searchGifs',
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
  conversation(peerId: string): EffectConversation | undefined;
  openConversation(peerId: string): Effect.Effect<EffectConversation, MessagingError>;
};

const _capabilitiesMatchClient: readonly (keyof EffectMessagingClient)[] = messagingCapabilities;
void _capabilitiesMatchClient;
