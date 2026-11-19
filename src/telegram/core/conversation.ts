import { savedDraftKey, messageInSavedDialog } from '../savedMessages';
import { forumDraftKey } from '../forums';
import type { TelegramSearchFilters } from '../types';
import type { TelegramForwardOptions } from '../types';
import type {
  EditMediaOptions,
  ConversationViewSnapshot,
  EngineSnapshot,
  TelegramActivityKind,
  TelegramBotCallbackResult,
  TelegramBotCommand,
  TelegramDraftDetails,
  TelegramHistoryGap,
  TelegramMessage,
  TelegramPeer,
  TelegramReplyTarget,
  TelegramSearchOffset,
  TelegramSearchPage,
  TelegramSticker,
  TelegramTextFormat,
  TelegramUserDetails,
  TelegramUrlAuthAcceptOptions,
  TelegramUrlAuthResult,
  SharedMediaKind,
  OutgoingAttachment,
} from '../types';
import { Effect } from 'effect';
import { MessagingError } from './messagingError';

type Attachment = OutgoingAttachment;
type Operation<Value> = Effect.Effect<Value, MessagingError>;

export interface ConversationHost {
  snapshot(): EngineSnapshot;
  setDraft(peerId: string, text: string, details?: TelegramDraftDetails): Operation<void>;
  setTyping(peer: TelegramPeer, kind?: TelegramActivityKind): Operation<void>;
  sendDraft(
    peer: TelegramPeer,
    text: string,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ): Operation<void>;
  sendAttachments(
    peer: TelegramPeer,
    attachments: Attachment[],
    caption?: string,
    reply?: TelegramReplyTarget,
    formats?: TelegramTextFormat[],
  ): Operation<void>;
  editMessage(
    peer: TelegramPeer,
    messageId: number,
    text: string,
    formats?: TelegramTextFormat[],
    replacement?: EditMediaOptions,
  ): Operation<unknown>;
  getBotCommands(peer: TelegramPeer): Operation<TelegramBotCommand[]>;
  searchGifs(peer: TelegramPeer, query: string): Operation<TelegramSticker[]>;
  startBot(peer: TelegramPeer, startParam?: string): Operation<void>;
  answerBotCallback(
    peer: TelegramPeer,
    messageId: number,
    data: number[],
  ): Operation<TelegramBotCallbackResult | undefined>;
  requestUrlAuth(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
  ): Operation<TelegramUrlAuthResult | undefined>;
  acceptUrlAuth(
    peer: TelegramPeer,
    messageId: number,
    buttonId: number,
    options?: TelegramUrlAuthAcceptOptions,
  ): Operation<TelegramUrlAuthResult | undefined>;
  sendSticker(
    peer: TelegramPeer,
    sticker: TelegramSticker,
    reply?: TelegramReplyTarget,
  ): Operation<void>;
  toggleReaction(peer: TelegramPeer, messageId: number, emoji: string): Operation<void>;
  deleteMessage(peer: TelegramPeer, messageId: number, revoke: boolean): Operation<unknown>;
  openMessageInConversationView(
    message: TelegramMessage,
  ): Operation<{ conversation: ConversationViewSnapshot; found: boolean }>;
  loadOlderConversationView(peerId: string): Operation<ConversationViewSnapshot>;
  retryConversationView(peerId: string): Operation<ConversationViewSnapshot>;
  loadHistoryGapConversationView(
    peerId: string,
    gap: TelegramHistoryGap,
  ): Operation<ConversationViewSnapshot>;
  searchConversationMessages(
    peer: TelegramPeer,
    query: string,
    global: boolean,
    offset?: TelegramSearchOffset,
    filters?: TelegramSearchFilters,
  ): Operation<TelegramSearchPage>;
  getConversationSharedMedia(
    peer: TelegramPeer,
    kind: SharedMediaKind,
    offset?: TelegramSearchOffset,
  ): Operation<TelegramSearchPage>;
  forwardMessage(
    fromPeer: TelegramPeer,
    toPeer: TelegramPeer,
    messageId: number,
    options?: TelegramForwardOptions,
  ): Operation<void>;
  getUserDetails(peer: TelegramPeer): Operation<TelegramUserDetails>;
  setBlocked(peer: TelegramPeer, blocked: boolean): Operation<unknown>;
  setPinnedMessage(peer: TelegramPeer, messageId: number, pinned: boolean): Operation<unknown>;
}

/**
 * A peer-addressed command handle plus selected-view operations. Commands keep
 * their bound peer when the UI selection changes; only operations backed by the
 * engine's current history projection require this conversation to be selected.
 */
export function makeConversation(
  host: ConversationHost,
  peer: TelegramPeer,
  topicId?: number,
  savedPeer?: TelegramPeer,
) {
  const peerId = peer.id;
  const draftKey = savedPeer ? savedDraftKey(peerId, savedPeer) : forumDraftKey(peerId, topicId);
  const topicReply = (reply?: TelegramReplyTarget): TelegramReplyTarget | undefined =>
    topicId === undefined
      ? reply
      : { ...reply, messageId: reply?.messageId ?? topicId, topMessageId: topicId };
  const requireSelectedView = Effect.suspend(() => {
    const snapshot = host.snapshot();
    if (
      snapshot.activePeerId !== peerId ||
      snapshot.activeTopicId !== topicId ||
      snapshot.activeSavedPeer?.id !== savedPeer?.id
    ) {
      return Effect.fail(
        new MessagingError({
          message: 'This conversation is no longer selected.',
          operation: 'conversation-view',
        }),
      );
    }
    return Effect.void;
  });

  return {
    peer,
    peerId,
    topicId,
    savedPeer,
    draftKey,
    setDraft(text: string, details?: TelegramDraftDetails) {
      return host.setDraft(draftKey, text, details);
    },
    setTyping: (kind?: TelegramActivityKind) => host.setTyping(peer, kind),
    sendDraft: (text: string, reply?: TelegramReplyTarget, formats?: TelegramTextFormat[]) =>
      host.sendDraft(peer, text, topicReply(reply), formats),
    sendAttachments: (
      attachments: Attachment[],
      caption?: string,
      reply?: TelegramReplyTarget,
      formats?: TelegramTextFormat[],
    ) => host.sendAttachments(peer, attachments, caption, topicReply(reply), formats),
    editMessage: (
      messageId: number,
      text: string,
      formats?: TelegramTextFormat[],
      replacement?: EditMediaOptions,
    ) => host.editMessage(peer, messageId, text, formats, replacement),
    getBotCommands: () => host.getBotCommands(peer),
    searchGifs: (query: string) => host.searchGifs(peer, query),
    startBot: (startParam: string = '') => host.startBot(peer, startParam),
    answerBotCallback: (messageId: number, data: number[]) =>
      host.answerBotCallback(peer, messageId, data),
    requestUrlAuth: (messageId: number, buttonId: number) =>
      host.requestUrlAuth(peer, messageId, buttonId),
    acceptUrlAuth: (messageId: number, buttonId: number, options?: TelegramUrlAuthAcceptOptions) =>
      host.acceptUrlAuth(peer, messageId, buttonId, options),
    sendSticker: (sticker: TelegramSticker, reply?: TelegramReplyTarget) =>
      host.sendSticker(peer, sticker, topicReply(reply)),
    toggleReaction: (messageId: number, emoji: string) =>
      host.toggleReaction(peer, messageId, emoji),
    deleteMessage: (messageId: number, revoke: boolean) =>
      host.deleteMessage(peer, messageId, revoke),
    openMessage(message: TelegramMessage) {
      if (message.peerId !== peerId || (savedPeer && !messageInSavedDialog(message, savedPeer.id)))
        return Effect.fail(
          new MessagingError({
            message: 'The message belongs to another chat.',
            operation: 'open-message',
          }),
        );
      return host.openMessageInConversationView(message).pipe(Effect.map(({ found }) => found));
    },
    loadOlder() {
      return requireSelectedView.pipe(
        Effect.andThen(host.loadOlderConversationView(peerId)),
        Effect.asVoid,
      );
    },
    retryHistory() {
      return requireSelectedView.pipe(
        Effect.andThen(host.retryConversationView(peerId)),
        Effect.asVoid,
      );
    },
    loadGap(gap: TelegramHistoryGap) {
      return requireSelectedView.pipe(
        Effect.andThen(host.loadHistoryGapConversationView(peerId, gap)),
        Effect.asVoid,
      );
    },
    search(
      query: string,
      global: boolean,
      offset?: TelegramSearchOffset,
      filters?: TelegramSearchFilters,
    ) {
      return host.searchConversationMessages(
        peer,
        query,
        global,
        offset,
        !global && savedPeer
          ? { ...filters, savedPeer }
          : !global && topicId !== undefined
            ? { ...filters, topicId }
            : filters,
      );
    },
    sharedMedia(kind: SharedMediaKind, offset?: TelegramSearchOffset) {
      return savedPeer
        ? host.searchConversationMessages(peer, '', false, offset, { kind, savedPeer })
        : topicId !== undefined
          ? host.searchConversationMessages(peer, '', false, offset, { kind, topicId })
          : host.getConversationSharedMedia(peer, kind, offset);
    },
    forwardTo: (target: TelegramPeer, messageId: number, options?: TelegramForwardOptions) =>
      host.forwardMessage(peer, target, messageId, options),
    userDetails: () => host.getUserDetails(peer),
    setBlocked: (blocked: boolean) => host.setBlocked(peer, blocked),
    setPinnedMessage: (messageId: number, pinned: boolean) =>
      host.setPinnedMessage(peer, messageId, pinned),
  };
}

export type EffectConversation = ReturnType<typeof makeConversation>;
