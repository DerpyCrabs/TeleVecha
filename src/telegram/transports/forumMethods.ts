import { Effect } from 'effect';
import type { MtprotoClient } from '../mtproto';
import { createMtprotoError, type MtprotoError } from '../mtproto/errors';
import { Api, type Tl } from '../mtproto/tl';
import type { TelegramForumEdit, TelegramForumOffset, TelegramForumPage } from '../forums';
import type { TelegramMessage, TelegramPeer } from '../types';

export function forumMethods(context: {
  client: Effect.Effect<MtprotoClient, MtprotoError>;
  inputPeer(peer: TelegramPeer): Tl.TypeInputPeer;
  message(raw: Tl.TypeMessage): TelegramMessage | undefined;
  remember(users: readonly Tl.TypeUser[], chats: readonly Tl.TypeChat[]): void;
  rights(peer: TelegramPeer): { canCreate: boolean; canManage: boolean };
}) {
  const mapTopic = (topic: Tl.ForumTopic) => ({
    id: topic.id,
    title: topic.title,
    iconColor: topic.iconColor,
    iconEmojiId: topic.iconEmojiId?.toString(),
    date: topic.date,
    topMessageId: topic.topMessage,
    readInboxMaxId: topic.readInboxMaxId,
    readOutboxMaxId: topic.readOutboxMaxId,
    unreadCount: topic.unreadCount,
    unreadMentionsCount: topic.unreadMentionsCount,
    unreadReactionsCount: topic.unreadReactionsCount,
    closed: Boolean(topic.closed),
    hidden: Boolean(topic.hidden),
    pinned: Boolean(topic.pinned),
    own: Boolean(topic.my),
  });
  const getForumTopics = Effect.fn('Forums.list')(function* (
    peer: TelegramPeer,
    query: string = '',
    offset?: TelegramForumOffset,
  ): Effect.fn.Return<TelegramForumPage, MtprotoError> {
    const result = yield* (yield* context.client).invoke(
      Api.messages.GetForumTopics({
        peer: context.inputPeer(peer),
        ...(query.trim() ? { q: query.trim() } : {}),
        offsetDate: offset?.date ?? 0,
        offsetId: offset?.messageId ?? 0,
        offsetTopic: offset?.topicId ?? 0,
        limit: 50,
      }),
    );
    context.remember(result.users, result.chats);
    const topics = result.topics.filter((topic) => Api.ForumTopic.is(topic));
    const messages = result.messages.flatMap((raw) => {
      const message = context.message(raw);
      return message ? [message] : [];
    });
    const last = topics.at(-1);
    const nextOffset =
      last && result.topics.length === 50
        ? {
            topicId: last.id,
            messageId: last.topMessage,
            date: result.orderByCreateDate
              ? last.date
              : (messages.find((message) => message.id === last.topMessage)?.date ?? last.date),
          }
        : undefined;
    return {
      topics: topics.map(mapTopic),
      messages,
      count: result.count,
      ...context.rights(peer),
      nextOffset:
        nextOffset &&
        offset &&
        nextOffset.date === offset.date &&
        nextOffset.topicId === offset.topicId &&
        nextOffset.messageId === offset.messageId
          ? undefined
          : nextOffset,
    };
  });
  const deleteForumTopic = Effect.fn('Forums.delete')(function* (
    peer: TelegramPeer,
    topicId: number,
  ) {
    const client = yield* context.client;
    let ptsCount = 0;
    for (let page = 0; page < 100; page += 1) {
      const result = yield* client.invoke(
        Api.messages.DeleteTopicHistory({ peer: context.inputPeer(peer), topMsgId: topicId }),
      );
      ptsCount += result.ptsCount;
      if (result.offset <= 0) return { pts: result.pts, ptsCount };
    }
    return yield* Effect.fail(
      createMtprotoError('protocol', 'Telegram did not finish deleting this topic.'),
    );
  });
  const getForumTopic = Effect.fn('Forums.get')(function* (peer: TelegramPeer, topicId: number) {
    const result = yield* (yield* context.client).invoke(
      Api.messages.GetForumTopicsByID({ peer: context.inputPeer(peer), topics: [topicId] }),
    );
    context.remember(result.users, result.chats);
    const topic = result.topics.find((topic) => Api.ForumTopic.is(topic) && topic.id === topicId);
    return topic && Api.ForumTopic.is(topic) ? mapTopic(topic) : undefined;
  });
  const createForumTopic = Effect.fn('Forums.create')(function* (
    peer: TelegramPeer,
    title: string,
    iconColor: number,
    randomId: string,
    iconEmojiId?: string,
  ) {
    return yield* (yield* context.client).invoke(
      Api.messages.CreateForumTopic({
        peer: context.inputPeer(peer),
        title,
        iconColor,
        randomId: BigInt(randomId),
        ...(iconEmojiId ? { iconEmojiId: BigInt(iconEmojiId) } : {}),
      }),
    );
  });
  const editForumTopic = Effect.fn('Forums.edit')(function* (
    peer: TelegramPeer,
    topicId: number,
    edit: TelegramForumEdit,
  ) {
    return yield* (yield* context.client).invoke(
      Api.messages.EditForumTopic({
        peer: context.inputPeer(peer),
        topicId,
        ...(edit.title !== undefined ? { title: edit.title } : {}),
        ...(edit.iconEmojiId !== undefined ? { iconEmojiId: BigInt(edit.iconEmojiId) } : {}),
        ...(edit.closed !== undefined ? { closed: edit.closed } : {}),
        ...(edit.hidden !== undefined ? { hidden: edit.hidden } : {}),
      }),
    );
  });
  const pinForumTopic = Effect.fn('Forums.pin')(function* (
    peer: TelegramPeer,
    topicId: number,
    pinned: boolean,
  ) {
    return yield* (yield* context.client).invoke(
      Api.messages.UpdatePinnedForumTopic({ peer: context.inputPeer(peer), topicId, pinned }),
    );
  });
  const readForumTopic = Effect.fn('Forums.read')(function* (
    peer: TelegramPeer,
    topicId: number,
    maxMessageId: number,
  ) {
    yield* (yield* context.client).invoke(
      Api.messages.ReadDiscussion({
        peer: context.inputPeer(peer),
        msgId: topicId,
        readMaxId: maxMessageId,
      }),
    );
  });
  return {
    deleteForumTopic,
    getForumTopic,
    getForumTopics,
    createForumTopic,
    editForumTopic,
    pinForumTopic,
    readForumTopic,
  };
}
