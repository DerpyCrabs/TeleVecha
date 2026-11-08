import type { Effect } from 'effect';
import type { TelegramPeer, TelegramMessage } from './types';

export interface TelegramForumTopic {
  id: number;
  title: string;
  iconColor: number;
  iconEmojiId?: string | undefined;
  date: number;
  topMessageId: number;
  readInboxMaxId: number;
  readOutboxMaxId?: number;
  unreadCount: number;
  unreadMentionsCount: number;
  unreadReactionsCount: number;
  closed: boolean;
  hidden: boolean;
  pinned: boolean;
  own: boolean;
}
export interface TelegramForumOffset {
  date: number;
  messageId: number;
  topicId: number;
}
export interface TelegramForumPage {
  topics: TelegramForumTopic[];
  messages: TelegramMessage[];
  count: number;
  nextOffset?: TelegramForumOffset | undefined;
  canCreate: boolean;
  canManage: boolean;
}
export interface TelegramForumEdit {
  title?: string;
  iconEmojiId?: string;
  closed?: boolean;
  hidden?: boolean;
}
export interface ForumsApi {
  deleteForumTopic(peer: TelegramPeer, topicId: number): Effect.Effect<void, unknown>;
  getForumTopic(
    peer: TelegramPeer,
    topicId: number,
  ): Effect.Effect<TelegramForumTopic | undefined, unknown>;
  getForumTopics(
    peer: TelegramPeer,
    query?: string,
    offset?: TelegramForumOffset,
  ): Effect.Effect<TelegramForumPage, unknown>;
  createForumTopic(
    peer: TelegramPeer,
    title: string,
    iconColor: number,
    iconEmojiId?: string,
  ): Effect.Effect<void, unknown>;
  editForumTopic(
    peer: TelegramPeer,
    topicId: number,
    edit: TelegramForumEdit,
  ): Effect.Effect<void, unknown>;
  pinForumTopic(peer: TelegramPeer, topicId: number, pinned: boolean): Effect.Effect<void, unknown>;
  readForumTopic(
    peer: TelegramPeer,
    topicId: number,
    maxMessageId: number,
  ): Effect.Effect<void, unknown>;
}

/** Drafts and view state belong to a topic; Telegram RPC peers still address the real chat. */
export function forumDraftKey(peerId: string, topicId?: number) {
  return topicId === undefined ? peerId : `${peerId}/topic/${topicId}`;
}
export function messageInTopic(message: TelegramMessage, topicId: number) {
  return (
    message.topicId === topicId ||
    message.id === topicId ||
    (topicId === 1 && message.topicId === undefined)
  );
}
