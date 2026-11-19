import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import type { MtprotoClient } from '../mtproto';
import { Api, createTl } from '../mtproto/tl';
import { forumMethods } from './forumMethods';
const peer = { id: 'c:202', kind: 'channel' as const, accessHash: '5' };
function methods(invoke: (request: unknown) => Effect.Effect<unknown>) {
  return forumMethods({
    client: Effect.succeed({ invoke } as unknown as MtprotoClient),
    inputPeer: () => Api.InputPeerChannel({ channelId: 202n, accessHash: 5n }),
    remember: () => {},
    message: () => undefined,
    rights: () => ({ canCreate: true, canManage: false }),
  });
}
const updates = () => Api.Updates({ updates: [], users: [], chats: [], date: 0, seq: 0 });
const topic = (id: number) =>
  createTl('forumTopic', {
    id,
    date: 100 + id,
    peer: Api.PeerChannel({ channelId: 202n }),
    title: `Topic ${id}`,
    iconColor: 0x6fb9f0,
    topMessage: id + 1000,
    readInboxMaxId: id,
    readOutboxMaxId: id,
    unreadCount: 3,
    unreadMentionsCount: 1,
    unreadReactionsCount: 0,
    unreadPollVotesCount: 0,
    fromId: Api.PeerUser({ userId: 101n }),
    notifySettings: Api.PeerNotifySettings({}),
    my: true,
    closed: true,
  });
describe('forum RPCs', () => {
  it('loads a page with topic flags, rights and a stable creation-date cursor', async () => {
    const api = methods((request) => {
      expect(request).toMatchObject({
        q: 'Work',
        offsetDate: 20,
        offsetId: 30,
        offsetTopic: 10,
        limit: 50,
      });
      return Effect.succeed(
        createTl('messages.forumTopics', {
          count: 51,
          orderByCreateDate: true,
          topics: Array.from({ length: 50 }, (_, index) => topic(index + 1)),
          messages: [],
          chats: [],
          users: [],
          pts: 0,
        }),
      );
    });
    const result = await Effect.runPromise(
      api.getForumTopics(peer, ' Work ', { date: 20, messageId: 30, topicId: 10 }),
    );
    expect(result.topics[0]).toMatchObject({
      id: 1,
      title: 'Topic 1',
      own: true,
      closed: true,
      unreadCount: 3,
    });
    expect(result).toMatchObject({
      canCreate: true,
      canManage: false,
      nextOffset: { date: 150, messageId: 1050, topicId: 50 },
    });
  });
  it('keeps false flags when reopening and unhiding a topic', async () => {
    const invoke = vi.fn((_request: unknown) => Effect.succeed(updates()));
    await Effect.runPromise(
      methods(invoke).editForumTopic(peer, 1, { closed: false, hidden: false }),
    );
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ topicId: 1, closed: false, hidden: false });
    expect(invoke.mock.calls[0]?.[0]).not.toHaveProperty('title');
  });
  it('creates with the supplied random ID and reads only the chosen topic', async () => {
    const invoke = vi.fn((_request: unknown) => Effect.succeed(updates()));
    const api = methods(invoke);
    await Effect.runPromise(api.createForumTopic(peer, 'Work', 0x6fb9f0, '-123'));
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      title: 'Work',
      randomId: -123n,
      iconColor: 0x6fb9f0,
    });
    await Effect.runPromise(api.readForumTopic(peer, 42, 99));
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      _: 'messages.readDiscussion',
      msgId: 42,
      readMaxId: 99,
    });
    await Effect.runPromise(api.pinForumTopic(peer, 42, false));
    expect(invoke.mock.calls[2]?.[0]).toMatchObject({ topicId: 42, pinned: false });
  });
});

it('loads a topic outside the first page by its exact ID', async () => {
  const api = methods((request) => {
    expect(request).toMatchObject({ _: 'messages.getForumTopicsByID', topics: [900] });
    return Effect.succeed(
      createTl('messages.forumTopics', {
        count: 1,
        topics: [topic(900)],
        messages: [],
        chats: [],
        users: [],
        pts: 0,
      }),
    );
  });
  expect(await Effect.runPromise(api.getForumTopic(peer, 900))).toMatchObject({
    id: 900,
    title: 'Topic 900',
  });
});
it('finishes all server deletion pages before confirming removal', async () => {
  let page = 0;
  const api = methods((request) => {
    expect(request).toMatchObject({ _: 'messages.deleteTopicHistory', topMsgId: 42 });
    page += 1;
    return Effect.succeed(
      createTl('messages.affectedHistory', {
        pts: page * 10,
        ptsCount: 10,
        offset: page === 1 ? 1 : 0,
      }),
    );
  });
  expect(await Effect.runPromise(api.deleteForumTopic(peer, 42))).toEqual({
    pts: 20,
    ptsCount: 20,
  });
  expect(page).toBe(2);
});

it('does not offer the same forum page again when the cursor stops moving', async () => {
  const api = methods(() =>
    Effect.succeed(
      createTl('messages.forumTopics', {
        count: 100,
        orderByCreateDate: true,
        topics: Array.from({ length: 50 }, (_, i) => topic(i + 1)),
        messages: [],
        chats: [],
        users: [],
        pts: 0,
      }),
    ),
  );
  expect(
    (
      await Effect.runPromise(
        api.getForumTopics(peer, '', { date: 150, messageId: 1050, topicId: 50 }),
      )
    ).nextOffset,
  ).toBeUndefined();
});
