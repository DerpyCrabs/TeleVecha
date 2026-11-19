import { Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import { Api, createTl, type Tl } from '../mtproto/tl';
import type { MtprotoClient } from '../mtproto';
import { savedMessagesMethods } from './savedMessagesMethods';
const self = createTl('user', {
  id: 1n,
  self: true,
  premium: true,
  accessHash: 10n,
  firstName: 'Me',
});
const source = { id: 'u:2', kind: 'user' as const, accessHash: '20' };
const peer = (peer: Tl.TypePeer) =>
  peer._ === 'peerUser'
    ? { id: `u:${peer.userId}`, kind: 'user' as const, accessHash: `${peer.userId * 10n}` }
    : undefined;
function methods(invoke: (request: unknown) => Effect.Effect<unknown>, premium = true) {
  return savedMessagesMethods({
    client: Effect.succeed({
      invoke,
      getMe: Effect.succeed({ ...self, premium }),
    } as unknown as MtprotoClient),
    inputPeer: (value) =>
      value.id === 'u:1'
        ? Api.InputPeerSelf()
        : Api.InputPeerUser({
            userId: BigInt(value.id.slice(2)),
            accessHash: BigInt(value.accessHash ?? '0'),
          }),
    peer,
    person: (peer) => ({
      peer,
      title: peer.id,
      initials: 'U',
      color: '#5288c1',
      hasAvatar: false,
      category: 'user',
      bot: false,
      isContact: false,
    }),
    remember: () => {},
    message: (message) =>
      message._ === 'message'
        ? {
            id: message.id,
            peerId: 'u:1',
            savedPeerId: 'u:2',
            senderId: 'u:1',
            text: message.message,
            date: message.date,
            outgoing: true,
          }
        : undefined,
  });
}
const rawMessage = (id: number) =>
  createTl('message', {
    id,
    peerId: Api.PeerUser({ userId: 1n }),
    savedPeerId: Api.PeerUser({ userId: 2n }),
    date: 1000 + id,
    message: `Saved ${id}`,
  });
it('loads pinned saved chats separately and does not mix them into pagination offsets', async () => {
  const invoke = vi.fn((request: unknown) => {
    if (Api.messages.GetPinnedSavedDialogs.is(request))
      return Effect.succeed(
        createTl('messages.savedDialogs', {
          dialogs: [
            createTl('savedDialog', {
              peer: Api.PeerUser({ userId: 1n }),
              topMessage: 200,
              pinned: true,
            }),
          ],
          messages: [rawMessage(200)],
          chats: [],
          users: [],
        }),
      );
    return Effect.succeed(
      createTl('messages.savedDialogsSlice', {
        count: 60,
        dialogs: Array.from({ length: 50 }, (_, i) =>
          createTl('savedDialog', {
            peer: Api.PeerUser({ userId: BigInt(i + 2) }),
            topMessage: 100 - i,
          }),
        ),
        messages: Array.from({ length: 50 }, (_, i) => rawMessage(100 - i)),
        chats: [],
        users: [],
      }),
    );
  });
  const api = methods(invoke);
  const first = await Effect.runPromise(api.getSavedDialogs());
  expect(first.dialogs[0]).toMatchObject({ title: 'My Notes', pinned: true });
  expect(first.nextOffset).toEqual({
    peer: { id: 'u:51', kind: 'user', accessHash: '510' },
    messageId: 51,
    date: 1051,
  });
  await Effect.runPromise(api.getSavedDialogs(first.nextOffset));
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(invoke.mock.calls[2]?.[0]).toMatchObject({
    _: 'messages.getSavedDialogs',
    excludePinned: true,
    offsetId: 51,
    offsetDate: 1051,
    offsetPeer: { userId: 51n },
  });
});
it('keeps the destination in Saved Messages while paging history by source', async () => {
  const invoke = vi.fn((_request: unknown) =>
    Effect.succeed(
      createTl('messages.messages', {
        messages: [rawMessage(30), rawMessage(29), rawMessage(28)],
        chats: [],
        users: [],
      }),
    ),
  );
  const page = await Effect.runPromise(methods(invoke).getSavedHistory(source, 2, 31));
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({
    _: 'messages.getSavedHistory',
    peer: { userId: 2n },
    offsetId: 31,
    limit: 3,
  });
  expect(page.messages.map((message) => message.id)).toEqual([29, 30]);
  expect(page.messages.every((message) => message.peerId === 'u:1')).toBe(true);
  expect(page.hasOlder).toBe(true);
});
it('sorts named tags by count and deduplicates default suggestions', async () => {
  const invoke = (request: unknown) =>
    Api.messages.GetSavedReactionTags.is(request)
      ? Effect.succeed(
          createTl('messages.savedReactionTags', {
            hash: 0n,
            tags: [
              createTl('savedReactionTag', {
                reaction: Api.ReactionEmoji({ emoticon: '⭐' }),
                title: 'Ideas',
                count: 3,
              }),
              createTl('savedReactionTag', {
                reaction: Api.ReactionCustomEmoji({ documentId: 99n }),
                count: 9,
              }),
            ],
          }),
        )
      : Effect.succeed(
          createTl('messages.reactions', {
            hash: 0n,
            reactions: [
              Api.ReactionEmoji({ emoticon: '⭐' }),
              Api.ReactionEmoji({ emoticon: '❤' }),
            ],
          }),
        );
  const result = await Effect.runPromise(methods(invoke).getSavedTags(source));
  expect(result.tags.map((tag) => tag.reaction)).toEqual(['custom:99', '⭐']);
  expect(result.recommended).toEqual(['❤']);
});
it('removes a tag name by omitting its title flag', async () => {
  const invoke = vi.fn((_request: unknown) => Effect.succeed(true));
  await Effect.runPromise(methods(invoke).renameSavedTag('⭐', ''));
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({
    _: 'messages.updateSavedReactionTag',
    reaction: { emoticon: '⭐' },
  });
  expect(invoke.mock.calls[0]?.[0]).not.toHaveProperty('title');
});
it('sends all selected tags to self and preserves custom emoji IDs', async () => {
  const invoke = vi.fn((_request: unknown) =>
    Effect.succeed(Api.Updates({ updates: [], chats: [], users: [], date: 1, seq: 1 })),
  );
  await Effect.runPromise(
    methods(invoke).setSavedMessageTags(30, ['⭐', 'custom:9007199254740993', '⭐']),
  );
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({
    peer: { _: 'inputPeerSelf' },
    msgId: 30,
    reaction: [{ emoticon: '⭐' }, { documentId: 9007199254740993n }],
  });
});
it('blocks tag writes without Premium and rejects malformed custom IDs before RPC', async () => {
  const invoke = vi.fn((_request: unknown) => Effect.succeed(true));
  await expect(
    Effect.runPromise(methods(invoke, false).setSavedMessageTags(30, ['⭐'])),
  ).rejects.toThrow('Premium');
  await expect(
    Effect.runPromise(methods(invoke).renameSavedTag('custom:no', 'Ideas')),
  ).rejects.toThrow('valid tag');
  expect(invoke).not.toHaveBeenCalled();
});
it('omits the true-only pin flag when unpinning a saved chat', async () => {
  const invoke = vi.fn((_request: unknown) => Effect.succeed(true));
  await Effect.runPromise(methods(invoke).pinSavedDialog(source, false));
  expect(invoke.mock.calls[0]?.[0]).not.toHaveProperty('pinned');
});

it('uses the newer pinned response when the source was pinned between the two reads', async () => {
  const invoke = (request: unknown) => {
    const pinned = Api.messages.GetPinnedSavedDialogs.is(request);
    const topMessage = pinned ? 31 : 30;
    return Effect.succeed(
      createTl('messages.savedDialogs', {
        dialogs: [
          createTl('savedDialog', { peer: Api.PeerUser({ userId: 2n }), topMessage, pinned }),
        ],
        messages: [rawMessage(topMessage)],
        users: [],
        chats: [],
      }),
    );
  };
  const page = await Effect.runPromise(methods(invoke).getSavedDialogs());
  expect(page.dialogs).toHaveLength(1);
  expect(page.dialogs[0]).toMatchObject({ pinned: true, topMessage: { id: 31 } });
});

it('stops when Telegram repeats the saved-dialog pagination cursor', async () => {
  const invoke = () =>
    Effect.succeed(
      createTl('messages.savedDialogsSlice', {
        count: 100,
        dialogs: Array.from({ length: 50 }, (_, i) =>
          createTl('savedDialog', {
            peer: Api.PeerUser({ userId: BigInt(i + 2) }),
            topMessage: 100 - i,
          }),
        ),
        messages: Array.from({ length: 50 }, (_, i) => rawMessage(100 - i)),
        chats: [],
        users: [],
      }),
    );
  const page = await Effect.runPromise(
    methods(invoke).getSavedDialogs({
      peer: { id: 'u:51', kind: 'user' },
      messageId: 51,
      date: 1051,
    }),
  );
  expect(page.nextOffset).toBeUndefined();
});
