import { Crypto, Effect, Fiber, PubSub, Stream } from 'effect';
import * as Socket from 'effect/socket/Socket';
import { describe, expect, it, vi } from 'vitest';

import type { CreateMtprotoClientOptions, MtprotoClient } from '../mtproto';
import { updateEvent, type MtprotoClientEvent } from '../mtproto/events';
import { createMtprotoError } from '../mtproto/errors';
import { Api, createTl } from '../mtproto/tl';
import { makeMemoryCacheStore } from '../persistence/memoryStore';
import { createWebTelegramTransport } from './webTelegramTransport';

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data.slice(0, 32)),
});
const unusedSocket = (() => {
  throw new Error('Unexpected WebSocket construction.');
}) as Socket.WebSocketConstructor['Service'];

const providePlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(Crypto.Crypto, testCrypto),
    Effect.provideService(Socket.WebSocketConstructor, unusedSocket),
  ) as Effect.Effect<A, E, Exclude<R, Crypto.Crypto | Socket.WebSocketConstructor>>;

const clientDouble = (overrides: Partial<MtprotoClient> = {}): MtprotoClient => ({
  apiId: 1,
  apiHash: 'hash',
  connect: Effect.void,
  connected: Effect.succeed(true),
  invoke: (() =>
    Effect.fail(
      createMtprotoError('protocol', 'Unexpected RPC'),
    )) as unknown as MtprotoClient['invoke'],
  getMe: Effect.succeed(undefined),
  uploadFile: () => Effect.fail(createMtprotoError('protocol', 'Unexpected upload')),
  downloadFile: () => Effect.fail(createMtprotoError('protocol', 'Unexpected download')),
  downloadMedia: () => Effect.succeed(undefined),
  downloadProfilePhoto: () => Effect.succeed(undefined),
  events: Stream.empty,
  ...overrides,
});

const withTransport = <A, E>(
  use: (
    transport: Effect.Success<ReturnType<typeof createWebTelegramTransport>>,
  ) => Effect.Effect<A, E, never>,
  createClient: (options: CreateMtprotoClientOptions) => Effect.Effect<MtprotoClient> = () =>
    Effect.succeed(clientDouble()),
) =>
  Effect.scoped(
    providePlatform(
      Effect.gen(function* () {
        const transport = yield* createWebTelegramTransport(makeMemoryCacheStore(), {
          createClient,
        });
        return yield* use(transport);
      }),
    ),
  );

describe('web Telegram transport', () => {
  it('recovers a chat theme pattern absent from the account wallpaper catalog', () => {
    const document = Api.Document({
      id: 10n,
      accessHash: 11n,
      fileReference: new Uint8Array([1]),
      date: 1,
      mimeType: 'image/png',
      size: 3n,
      dcId: 2,
      attributes: [],
    });
    const invoke = vi.fn((request: unknown) => {
      if (Api.account.GetWallPapers.is(request)) {
        return Effect.succeed(createTl('account.wallPapers', { hash: 0n, wallpapers: [] }));
      }
      if (Api.account.GetChatThemes.is(request)) {
        return Effect.succeed(
          createTl('account.themes', {
            hash: 0n,
            themes: [
              Api.Theme({
                id: 20n,
                accessHash: 21n,
                slug: '',
                title: 'Chat theme',
                forChat: true,
                settings: [
                  Api.ThemeSettings({
                    baseTheme: Api.BaseThemeTinted(),
                    accentColor: 0x123456,
                    wallpaper: Api.WallPaper({
                      id: 30n,
                      accessHash: 31n,
                      slug: '',
                      pattern: true,
                      document,
                    }),
                  }),
                ],
              }),
            ],
          }),
        );
      }
      return Effect.fail(createMtprotoError('protocol', 'Unexpected RPC'));
    });
    const download = vi.fn(() => Effect.succeed(new Uint8Array([1, 2, 3])));
    return Effect.runPromise(
      withTransport(
        (target) =>
          Effect.gen(function* () {
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            expect((yield* target.downloadWallpaper!('30')).size).toBe(3);
            expect(download).toHaveBeenCalledWith(document, { workers: 1 });
            expect(invoke).toHaveBeenCalledTimes(2);
          }),
        () =>
          Effect.succeed(
            clientDouble({
              invoke: invoke as unknown as MtprotoClient['invoke'],
              downloadMedia: download,
            }),
          ),
      ),
    );
  });

  it.each([true, false])('preserves channel membership when fetching a dialog (left=%s)', (left) =>
    Effect.runPromise(
      withTransport(
        (target) =>
          Effect.gen(function* () {
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            const dialog = yield* target.getDialog!({
              id: 'c:707',
              kind: 'channel',
              accessHash: '77',
            });
            expect(Boolean(dialog?.transient)).toBe(left);
          }),
        () =>
          Effect.succeed(
            clientDouble({
              invoke: ((request: unknown) => {
                if (!Api.messages.GetPeerDialogs.is(request))
                  return Effect.fail(createMtprotoError('protocol', 'Unexpected RPC'));
                return Effect.succeed(
                  createTl('messages.peerDialogs', {
                    dialogs: [
                      Api.Dialog({
                        peer: Api.PeerChannel({ channelId: 707n }),
                        topMessage: 0,
                        readInboxMaxId: 0,
                        readOutboxMaxId: 0,
                        unreadCount: 0,
                        unreadMentionsCount: 0,
                        unreadReactionsCount: 0,
                        unreadPollVotesCount: 0,
                        notifySettings: Api.PeerNotifySettings(),
                      }),
                    ],
                    messages: [],
                    users: [],
                    chats: [
                      Api.Channel({
                        id: 707n,
                        accessHash: 77n,
                        title: 'Public News',
                        broadcast: true,
                        ...(left ? { left: true } : {}),
                        photo: Api.ChatPhotoEmpty(),
                        date: 1,
                      }),
                    ],
                    state: Api.updates.State({ pts: 0, qts: 0, date: 0, seq: 0, unreadCount: 0 }),
                  }),
                );
              }) as MtprotoClient['invoke'],
            }),
          ),
      ),
    ),
  );

  it('resolves a public channel and loads comments using the discussion peer and root, with entity hydration', () => {
    const channel = Api.Channel({
      id: 707n,
      accessHash: 77n,
      title: 'Public News',
      username: 'public_news',
      broadcast: true,
      photo: Api.ChatPhotoEmpty(),
      date: 1,
    });
    const group = Api.Channel({
      id: 909n,
      accessHash: 99n,
      title: 'Discussion',
      megagroup: true,
      photo: Api.ChatPhotoEmpty(),
      date: 1,
    });
    const post = Api.Message({
      id: 965,
      peerId: Api.PeerChannel({ channelId: 707n }),
      date: 1,
      message: 'Post',
      replies: Api.MessageReplies({ comments: true, replies: 3, repliesPts: 1, channelId: 909n }),
    });
    const root = Api.Message({
      id: 42,
      peerId: Api.PeerChannel({ channelId: 909n }),
      date: 1,
      message: 'Forwarded post',
    });
    const invoke = vi.fn((request: unknown) => {
      if (Api.contacts.ResolveUsername.is(request))
        return Effect.succeed(
          Api.contacts.ResolvedPeer({
            peer: Api.PeerChannel({ channelId: 707n }),
            chats: [channel],
            users: [],
          }),
        );
      if (Api.messages.GetHistory.is(request))
        return Effect.succeed(
          Api.messages.Messages({ messages: [post], chats: [channel], users: [], topics: [] }),
        );
      if (Api.messages.GetDiscussionMessage.is(request))
        return Effect.succeed(
          Api.messages.DiscussionMessage({
            messages: [{ ...root, id: 43 }, root, post],
            chats: [channel, group],
            users: [],
            unreadCount: 2,
          }),
        );
      if (Api.messages.GetReplies.is(request))
        return Effect.succeed(
          Api.messages.Messages({
            messages: [103, 102, 101].map((id) =>
              Api.Message({
                id,
                peerId: Api.PeerChannel({ channelId: 909n }),
                fromId: Api.PeerUser({ userId: 1n }),
                date: 2,
                message: `Comment ${id}`,
              }),
            ),
            chats: [group],
            users: [Api.User({ id: 1n, firstName: 'Commenter' })],
            topics: [],
          }),
        );
      return Effect.fail(createMtprotoError('protocol', 'Unexpected RPC'));
    });
    return Effect.runPromise(
      withTransport(
        (target) =>
          Effect.gen(function* () {
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            const resolved = yield* target.resolveUsername!('public_news');
            expect(resolved).toMatchObject({
              peer: { id: 'c:707', accessHash: '77' },
              category: 'channel',
              username: 'public_news',
            });
            const history = yield* target.getHistoryAround!(resolved!.peer, 965, 3);
            expect(history.messages[0]?.comments).toEqual({ count: 3, channelId: 'c:909' });
            const discussion = yield* target.getDiscussion!(resolved!.peer, 965);
            expect(discussion).toMatchObject({
              peer: { id: 'c:909', accessHash: '99' },
              root: { id: 42, peerId: 'c:909' },
            });
            const replies = yield* target.getReplies!(
              discussion!.peer,
              discussion!.root.id,
              2,
              104,
            );
            expect(replies).toMatchObject({
              hasOlder: true,
              nextBeforeMessageId: 102,
              messages: [
                { id: 103, senderName: 'Commenter' },
                { id: 102, senderName: 'Commenter' },
              ],
            });
            const request = invoke.mock.calls
              .map(([request]) => request)
              .find((request) => Api.messages.GetReplies.is(request));
            expect(request).toMatchObject({
              peer: { channelId: 909n, accessHash: 99n },
              msgId: 42,
              offsetId: 104,
              limit: 3,
            });
          }),
        () =>
          Effect.succeed(clientDouble({ invoke: invoke as unknown as MtprotoClient['invoke'] })),
      ),
    );
  });

  it.each(['MESSAGE_NOT_MODIFIED', 'MESSAGE_EDIT_TIME_EXPIRED', 'CHAT_WRITE_FORBIDDEN'])(
    'handles an edit response without hiding real failures: %s',
    (code) => {
      const error = createMtprotoError('rpc', `${code} (messages.editMessage)`, {
        code: 400,
        details: { errorMessage: code },
      });
      const invoke = vi.fn((request: unknown) => {
        if (Api.messages.EditMessage.is(request)) return Effect.fail(error);
        if (Api.messages.GetHistory.is(request))
          return Effect.succeed(
            Api.messages.Messages({
              messages: [
                Api.Message({
                  id: 42,
                  peerId: Api.PeerUser({ userId: 1n }),
                  date: 100,
                  message: 'ну как дешевая',
                  out: true,
                }),
              ],
              users: [],
              chats: [],
              topics: [],
            }),
          );
        return Effect.fail(createMtprotoError('protocol', 'Unexpected RPC'));
      });
      return Effect.runPromise(
        withTransport(
          (target) =>
            Effect.gen(function* () {
              yield* target.connect({ apiId: 1, apiHash: 'hash' });
              const edit = target.editMessage({ id: 'u:1', kind: 'user' }, 42, 'ну как дешевая');
              if (code === 'MESSAGE_NOT_MODIFIED') {
                const result = yield* edit;
                expect(result.message).toMatchObject({ id: 42, text: 'ну как дешевая' });
                expect(result.updateBatches).toEqual([]);
                expect(invoke).toHaveBeenCalledTimes(2);
              } else {
                expect(yield* edit.pipe(Effect.flip)).toBe(error);
                expect(invoke).toHaveBeenCalledOnce();
              }
            }),
          () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
        ),
      );
    },
  );

  it.each([
    { id: 'u:1', kind: 'user' as const },
    { id: 'g:2', kind: 'group' as const },
    { id: 'c:3', kind: 'channel' as const, accessHash: '33' },
  ])('sends content receipts through the correct $kind RPC and preserves PTS', (peer) => {
    const invoke = vi.fn((request: unknown) => {
      if (Api.channels.ReadMessageContents.is(request)) return Effect.succeed(true);
      if (Api.messages.ReadMessageContents.is(request))
        return Effect.succeed(Api.messages.AffectedMessages({ pts: 12, ptsCount: 2 }));
      return Effect.fail(createMtprotoError('protocol', 'Unexpected RPC'));
    });
    return Effect.runPromise(
      withTransport(
        (target) =>
          Effect.gen(function* () {
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            const result = yield* target.readMessageContents(peer, [81, 82]);
            expect(invoke).toHaveBeenCalledOnce();
            if (peer.kind === 'channel') {
              expect(invoke).toHaveBeenCalledWith(
                Api.channels.ReadMessageContents({
                  channel: Api.InputChannel({ channelId: 3n, accessHash: 33n }),
                  id: [81, 82],
                }),
              );
              expect(result).toEqual({});
            } else {
              expect(invoke).toHaveBeenCalledWith(
                Api.messages.ReadMessageContents({ id: [81, 82] }),
              );
              expect(result.updateBatches).toEqual([
                {
                  updates: [
                    {
                      type: 'read-message-contents',
                      peerId: peer.id,
                      messageIds: [81, 82],
                      pts: 12,
                      ptsCount: 2,
                    },
                  ],
                },
              ]);
            }
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });

  it('maps unread media and content receipts from other Telegram devices', () =>
    Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const events = yield* PubSub.sliding<MtprotoClientEvent>(8);
            const target = yield* createWebTelegramTransport(makeMemoryCacheStore(), {
              createClient: () =>
                Effect.succeed(clientDouble({ events: Stream.fromPubSub(events) })),
            });
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            const received = yield* target.updates.pipe(
              Stream.runHead,
              Effect.forkChild({ startImmediately: true }),
            );
            yield* PubSub.publish(
              events,
              updateEvent(
                Api.Updates({
                  users: [],
                  chats: [],
                  date: 10,
                  seq: 1,
                  updates: [
                    Api.UpdateNewMessage({
                      message: Api.Message({
                        id: 81,
                        peerId: Api.PeerUser({ userId: 1n }),
                        date: 10,
                        message: '',
                        mediaUnread: true,
                      }),
                      pts: 10,
                      ptsCount: 1,
                    }),
                    Api.UpdateReadMessagesContents({ messages: [81], pts: 11, ptsCount: 1 }),
                    Api.UpdateChannelReadMessagesContents({ channelId: 3n, messages: [81] }),
                  ],
                }),
              ),
            );
            const batch = yield* Fiber.join(received);
            expect(batch._tag).toBe('Some');
            if (batch._tag !== 'Some') return;
            expect(batch.value.updates).toMatchObject([
              { type: 'new-message', message: { id: 81, mediaUnread: true } },
              { type: 'read-message-contents', messageIds: [81], pts: 11, ptsCount: 1 },
              {
                type: 'read-message-contents',
                peerId: 'c:3',
                messageIds: [81],
                pts: 0,
                ptsCount: 0,
                channelScoped: true,
              },
            ]);
          }),
        ),
      ),
    ));

  it('exposes only the transport contract', () =>
    Effect.runPromise(
      withTransport((target) =>
        Effect.sync(() => {
          expect('client' in target).toBe(false);
          expect('mapMessage' in target).toBe(false);
          expect('clearRuntimeCaches' in target).toBe(false);
        }),
      ),
    ));

  it('keeps disconnected failures in the typed channel', () =>
    Effect.runPromise(
      withTransport((target) =>
        Effect.gen(function* () {
          const result = yield* target.getAuthorizedAccountId().pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'MtprotoError', kind: 'transport' },
          });
        }),
      ),
    ));

  it('coalesces concurrent connection acquisition in its scope', () => {
    const createClient = vi.fn(() => Effect.succeed(clientDouble()));
    return Effect.runPromise(
      withTransport(
        (target) =>
          Effect.all(
            [
              target.connect({ apiId: 1, apiHash: 'hash' }),
              target.connect({ apiId: 1, apiHash: 'hash' }),
            ],
            { concurrency: 'unbounded', discard: true },
          ).pipe(Effect.andThen(Effect.sync(() => expect(createClient).toHaveBeenCalledOnce()))),
        createClient,
      ),
    );
  });

  it.each(['👍', 'custom:99'])('loads named reactors filtered by %s', (emoji) =>
    Effect.runPromise(
      withTransport(
        (target) =>
          Effect.gen(function* () {
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            const result = yield* target.getReactionPeople!(
              { id: 'g:1', kind: 'group' },
              42,
              emoji,
            );
            expect(result).toMatchObject({
              people: [
                {
                  id: 'u:1',
                  name: 'Alice Example',
                  peer: { id: 'u:1', kind: 'user', accessHash: '101' },
                  initials: 'AE',
                  hasAvatar: true,
                  avatarId: '11',
                  color: expect.any(String) as unknown,
                },
                { id: 'u:2', name: 'You', initials: 'M', hasAvatar: false },
                {
                  id: 'c:3',
                  name: 'Team',
                  peer: { id: 'c:3', kind: 'channel', accessHash: '303' },
                  initials: 'T',
                  hasAvatar: true,
                  avatarId: '33',
                },
              ],
              count: 3,
            });
            expect(result.people[1]?.avatarId).toBeUndefined();
          }),
        () =>
          Effect.succeed(
            clientDouble({
              invoke: ((request: unknown) => {
                if (!Api.messages.GetMessageReactionsList.is(request))
                  return Effect.fail(createMtprotoError('protocol', 'Unexpected RPC'));
                expect(request.id).toBe(42);
                expect(request.limit).toBe(50);
                expect(request.reaction).toMatchObject(
                  emoji === '👍'
                    ? { _: 'reactionEmoji', emoticon: '👍' }
                    : { _: 'reactionCustomEmoji', documentId: 99n },
                );
                return Effect.succeed(
                  createTl('messages.messageReactionsList', {
                    count: 3,
                    reactions: [
                      createTl('messagePeerReaction', {
                        peerId: Api.PeerUser({ userId: 1n }),
                        date: 1,
                        reaction: request.reaction,
                      }),
                      createTl('messagePeerReaction', {
                        peerId: Api.PeerUser({ userId: 2n }),
                        date: 1,
                        reaction: request.reaction,
                      }),
                      createTl('messagePeerReaction', {
                        peerId: Api.PeerChannel({ channelId: 3n }),
                        date: 1,
                        reaction: request.reaction,
                      }),
                    ],
                    users: [
                      Api.User({
                        id: 1n,
                        accessHash: 101n,
                        firstName: 'Alice',
                        lastName: 'Example',
                        photo: Api.UserProfilePhoto({ photoId: 11n, dcId: 2 }),
                      }),
                      Api.User({ id: 2n, self: true, firstName: 'Me' }),
                    ],
                    chats: [
                      Api.Channel({
                        id: 3n,
                        title: 'Team',
                        accessHash: 303n,
                        photo: Api.ChatPhoto({ photoId: 33n, dcId: 2 }),
                        date: 1,
                      }),
                    ],
                  }),
                );
              }) as MtprotoClient['invoke'],
            }),
          ),
      ),
    ),
  );

  it('reports broadcast reactions as anonymous', () =>
    Effect.runPromise(
      withTransport(
        (target) =>
          Effect.gen(function* () {
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            expect(
              yield* target.getReactionPeople!(
                { id: 'c:1', kind: 'channel', accessHash: '1' },
                42,
                '👍',
              ),
            ).toEqual({ people: [], count: 0, anonymous: true });
          }),
        () =>
          Effect.succeed(
            clientDouble({
              invoke: (() =>
                Effect.fail(
                  createMtprotoError('rpc', 'BROADCAST_FORBIDDEN', {
                    code: 403,
                    details: { errorMessage: 'BROADCAST_FORBIDDEN' },
                  }),
                )) as MtprotoClient['invoke'],
            }),
          ),
      ),
    ));

  it('returns the raw Telegram user id for the authorized account', () =>
    Effect.runPromise(
      withTransport(
        (target) =>
          Effect.gen(function* () {
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            expect(yield* target.getAuthorizedAccountId()).toBe('991');
          }),
        () =>
          Effect.succeed(
            clientDouble({ getMe: Effect.succeed(Api.User({ id: 991n, firstName: 'Self' })) }),
          ),
      ),
    ));

  it('loads archived dialogs even when the main folder fills its page limit', () => {
    const requestedFolders: number[] = [];
    return Effect.runPromise(
      withTransport(
        (target) =>
          Effect.gen(function* () {
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            const page = yield* target.getDialogs(1);
            expect(requestedFolders).toEqual([0, 1]);
            expect(page.dialogs.map(({ peer, archived }) => [peer.id, archived])).toEqual([
              ['u:1', false],
              ['u:2', true],
            ]);
          }),
        () =>
          Effect.succeed(
            clientDouble({
              invoke: ((request: unknown) => {
                if (Api.messages.GetPinnedDialogs.is(request)) {
                  return Effect.succeed(
                    createTl('messages.peerDialogs', {
                      dialogs: [],
                      messages: [],
                      chats: [],
                      users: [],
                      state: Api.updates.State({ pts: 0, qts: 0, date: 0, seq: 0, unreadCount: 0 }),
                    }),
                  );
                }
                if (!Api.messages.GetDialogs.is(request)) {
                  return Effect.fail(createMtprotoError('protocol', 'Unexpected RPC'));
                }
                const archived = request.folderId === 1;
                requestedFolders.push(request.folderId ?? 0);
                const userId = archived ? 2n : 1n;
                return Effect.succeed(
                  createTl('messages.dialogs', {
                    dialogs: [
                      Api.Dialog({
                        peer: Api.PeerUser({ userId }),
                        topMessage: 0,
                        readInboxMaxId: 0,
                        readOutboxMaxId: 0,
                        unreadCount: 0,
                        unreadMentionsCount: 0,
                        unreadReactionsCount: 0,
                        unreadPollVotesCount: 0,
                        notifySettings: Api.PeerNotifySettings(),
                        ...(archived ? { folderId: 1 } : {}),
                      }),
                    ],
                    messages: [],
                    chats: [],
                    users: [Api.User({ id: userId, firstName: archived ? 'Archived' : 'Main' })],
                  }),
                );
              }) as MtprotoClient['invoke'],
            }),
          ),
      ),
    );
  });

  it('uses distinct Telegram deletion requests for each chat action', () => {
    const requests: unknown[] = [];
    return Effect.runPromise(
      withTransport(
        (target) =>
          Effect.gen(function* () {
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            const user = { id: 'u:1', kind: 'user' as const, accessHash: '1' };
            const group = { id: 'g:2', kind: 'group' as const, accessHash: '2' };
            const channel = { id: 'c:3', kind: 'channel' as const, accessHash: '3' };

            yield* target.deleteDialog(user, 'clear-for-me');
            const clear = requests.find((request) => Api.messages.DeleteHistory.is(request));
            expect(clear).toMatchObject({ justClear: true, maxId: 0 });
            expect((clear as { revoke?: true }).revoke).toBeUndefined();

            yield* target.deleteDialog(user);
            const defaultClear = requests
              .filter((request) => Api.messages.DeleteHistory.is(request))
              .at(-1);
            expect(defaultClear).toMatchObject({ justClear: true, maxId: 0 });

            yield* target.deleteDialog(user, 'delete-for-everyone');
            const revoke = requests
              .filter((request) => Api.messages.DeleteHistory.is(request))
              .at(-1);
            expect(revoke).toMatchObject({ revoke: true, maxId: 0 });
            expect((revoke as { justClear?: true }).justClear).toBeUndefined();

            yield* target.deleteDialog(group, 'leave');
            expect(requests.some((request) => Api.messages.DeleteChatUser.is(request))).toBe(true);
            expect(requests.some((request) => Api.messages.DeleteChat.is(request))).toBe(false);

            yield* target.deleteDialog(group, 'delete-chat');
            const deletedGroupHistory = requests
              .filter((request) => Api.messages.DeleteHistory.is(request))
              .at(-1);
            expect(deletedGroupHistory).toMatchObject({ revoke: true, maxId: 0 });
            expect(requests.some((request) => Api.messages.DeleteChat.is(request))).toBe(true);

            yield* target.deleteDialog(channel, 'leave');
            yield* target.deleteDialog(channel, 'delete-channel');
            expect(requests.some((request) => Api.channels.LeaveChannel.is(request))).toBe(true);
            expect(requests.some((request) => Api.channels.DeleteChannel.is(request))).toBe(true);
          }),
        () =>
          Effect.succeed(
            clientDouble({
              invoke: ((request: unknown) => {
                requests.push(request);
                if (Api.messages.DeleteHistory.is(request)) {
                  return Effect.succeed(
                    createTl('messages.affectedHistory', { pts: 1, ptsCount: 1, offset: 0 }),
                  );
                }
                if (Api.messages.DeleteChatUser.is(request)) {
                  return Effect.succeed(
                    createTl('updates', { updates: [], users: [], chats: [], date: 0, seq: 0 }),
                  );
                }
                if (Api.messages.DeleteChat.is(request)) {
                  return Effect.succeed(true);
                }
                if (
                  Api.channels.LeaveChannel.is(request) ||
                  Api.channels.DeleteChannel.is(request)
                ) {
                  return Effect.succeed(
                    createTl('updates', { updates: [], users: [], chats: [], date: 0, seq: 0 }),
                  );
                }
                return Effect.fail(createMtprotoError('protocol', 'Unexpected RPC'));
              }) as MtprotoClient['invoke'],
            }),
          ),
      ),
    );
  });

  it('publishes MTProto updates through its bounded update stream', () => {
    return Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const events = yield* PubSub.sliding<MtprotoClientEvent>(8);
            const client = clientDouble({ events: Stream.fromPubSub(events) });
            const target = yield* createWebTelegramTransport(makeMemoryCacheStore(), {
              createClient: () => Effect.succeed(client),
            });
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            const received = yield* target.updates.pipe(
              Stream.runHead,
              Effect.forkChild({ startImmediately: true }),
            );
            yield* PubSub.publish(
              events,
              updateEvent(
                Api.UpdateUserStatus({ userId: 1n, status: Api.UserStatusOnline({ expires: 10 }) }),
              ),
            );
            const batch = yield* Fiber.join(received);
            expect(batch._tag).toBe('Some');
            if (batch._tag === 'Some') expect(batch.value.updates).toHaveLength(1);
          }),
        ),
      ),
    );
  });

  it('preserves and downloads video documents from link previews', () => {
    return Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const events = yield* PubSub.sliding<MtprotoClientEvent>(8);
            const client = clientDouble({
              events: Stream.fromPubSub(events),
              downloadMedia: () => Effect.succeed(new Uint8Array([0, 0, 0, 24])),
            });
            const target = yield* createWebTelegramTransport(makeMemoryCacheStore(), {
              createClient: () => Effect.succeed(client),
            });
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            const received = yield* target.updates.pipe(
              Stream.runHead,
              Effect.forkChild({ startImmediately: true }),
            );
            yield* PubSub.publish(
              events,
              updateEvent(
                Api.UpdateNewMessage({
                  message: Api.Message({
                    id: 81,
                    peerId: Api.PeerUser({ userId: 1n }),
                    fromId: Api.PeerUser({ userId: 1n }),
                    date: 10,
                    message: 'https://packaged-media.redd.it/video.mp4',
                    media: Api.MessageMediaWebPage({
                      webpage: Api.WebPage({
                        id: 20n,
                        url: 'https://packaged-media.redd.it/video.mp4',
                        displayUrl: 'packaged-media.redd.it/video.mp4',
                        hash: 1,
                        type: 'video',
                        title: 'A long video title',
                        document: Api.Document({
                          id: 21n,
                          accessHash: 22n,
                          fileReference: new Uint8Array([1]),
                          date: 10,
                          mimeType: 'video/mp4',
                          size: 4n,
                          dcId: 2,
                          attributes: [
                            Api.DocumentAttributeFilename({ fileName: 'reddit-video.mp4' }),
                            Api.DocumentAttributeVideo({
                              supportsStreaming: true,
                              duration: 12,
                              w: 480,
                              h: 640,
                            }),
                          ],
                        }),
                      }),
                    }),
                  }),
                  pts: 1,
                  ptsCount: 1,
                }),
              ),
            );
            const batch = yield* Fiber.join(received);
            expect(batch._tag).toBe('Some');
            if (batch._tag !== 'Some') return;
            const update = batch.value.updates[0];
            expect(update).toMatchObject({
              type: 'new-message',
              message: {
                linkPreview: {
                  type: 'video',
                  media: {
                    kind: 'video',
                    name: 'reddit-video.mp4',
                    mimeType: 'video/mp4',
                    width: 480,
                    height: 640,
                    duration: 12,
                  },
                },
              },
            });
            if (update?.type !== 'new-message') return;
            const blob = yield* target.downloadMedia(update.message);
            expect(blob.type).toBe('video/mp4');
          }),
        ),
      ),
    );
  });

  it('emits a completed preview when updateWebPage supplies the video document later', () => {
    return Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const events = yield* PubSub.sliding<MtprotoClientEvent>(8);
            const downloadTargets: unknown[] = [];
            const videoBytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
            const client = clientDouble({
              events: Stream.fromPubSub(events),
              downloadMedia: (value) =>
                Effect.sync(() => {
                  downloadTargets.push(value);
                  return videoBytes;
                }),
            });
            const target = yield* createWebTelegramTransport(makeMemoryCacheStore(), {
              createClient: () => Effect.succeed(client),
            });
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            const received = yield* target.updates.pipe(
              Stream.take(2),
              Stream.runCollect,
              Effect.forkChild({ startImmediately: true }),
            );

            yield* PubSub.publish(
              events,
              updateEvent(
                Api.UpdateNewMessage({
                  message: Api.Message({
                    id: 81,
                    peerId: Api.PeerUser({ userId: 1n }),
                    fromId: Api.PeerUser({ userId: 1n }),
                    date: 10,
                    message: 'https://packaged-media.redd.it/video.mp4',
                    media: Api.MessageMediaWebPage({
                      webpage: Api.WebPage({
                        id: 20n,
                        url: 'https://packaged-media.redd.it/video.mp4',
                        displayUrl: 'packaged-media.redd.it/video.mp4',
                        hash: 1,
                      }),
                    }),
                  }),
                  pts: 1,
                  ptsCount: 1,
                }),
              ),
            );
            yield* PubSub.publish(
              events,
              updateEvent(
                createTl('updateWebPage', {
                  webpage: Api.WebPage({
                    id: 20n,
                    url: 'https://packaged-media.redd.it/video.mp4',
                    displayUrl: 'packaged-media.redd.it/video.mp4',
                    hash: 2,
                    type: 'video',
                    document: Api.Document({
                      id: 21n,
                      accessHash: 22n,
                      fileReference: new Uint8Array([1]),
                      date: 10,
                      mimeType: 'video/mp4',
                      size: 4n,
                      dcId: 2,
                      attributes: [
                        Api.DocumentAttributeFilename({ fileName: 'reddit-video.mp4' }),
                        Api.DocumentAttributeVideo({
                          supportsStreaming: true,
                          duration: 12,
                          w: 480,
                          h: 640,
                        }),
                      ],
                    }),
                  }),
                  pts: 2,
                  ptsCount: 1,
                }),
              ),
            );

            const batches = Array.from(yield* Fiber.join(received));
            expect(batches[1]?.updates).toMatchObject([
              {
                type: 'web-page-updated',
                webPageId: '20',
                linkPreview: {
                  type: 'video',
                  media: { kind: 'video', name: 'reddit-video.mp4', mimeType: 'video/mp4' },
                },
              },
            ]);
            const initial = batches[0]?.updates[0];
            const completed = batches[1]?.updates[0];
            if (initial?.type !== 'new-message' || completed?.type !== 'web-page-updated') return;
            const blob = yield* target.downloadMedia({
              ...initial.message,
              linkPreview: completed.linkPreview,
            });
            expect(downloadTargets).toMatchObject([
              {
                _: 'messageMediaWebPage',
                webpage: { _: 'webPage', document: { _: 'document', id: 21n } },
              },
            ]);
            expect(blob.type).toBe('video/mp4');
            expect(new Uint8Array(yield* Effect.promise(() => blob.arrayBuffer()))).toEqual(
              videoBytes,
            );
          }),
        ),
      ),
    );
  });

  it('preserves Telegram message-id correlation updates for the outbox', () => {
    return Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const events = yield* PubSub.sliding<MtprotoClientEvent>(8);
            const target = yield* createWebTelegramTransport(makeMemoryCacheStore(), {
              createClient: () =>
                Effect.succeed(clientDouble({ events: Stream.fromPubSub(events) })),
            });
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            const received = yield* target.updates.pipe(
              Stream.runHead,
              Effect.forkChild({ startImmediately: true }),
            );
            yield* PubSub.publish(
              events,
              updateEvent(
                Api.UpdateShort({
                  update: Api.UpdateMessageID({ id: 81, randomId: 123n }),
                  date: 10,
                }),
              ),
            );
            const batch = yield* Fiber.join(received);
            expect(batch).toMatchObject({
              _tag: 'Some',
              value: { updates: [{ type: 'message-id-assigned', messageId: 81, randomId: '123' }] },
            });
          }),
        ),
      ),
    );
  });
});

it('sends username and named mentions with UTF-16 offsets and the selected user access hash', () =>
  Effect.runPromise(
    withTransport(
      (transport) =>
        transport
          .sendText({ id: 'g:303', kind: 'group' }, '😀 @alice Bob', '1', undefined, [
            { kind: 'mention', offset: 3, length: 6 },
            { kind: 'mentionName', offset: 10, length: 3, userId: 'u:405', accessHash: '77' },
          ])
          .pipe(Effect.ignore),
      () =>
        Effect.succeed(
          clientDouble({
            invoke: ((request) =>
              Effect.sync(() => {
                if (!Api.messages.SendMessage.is(request)) throw new Error('Unexpected RPC');
                expect(request.entities).toEqual([
                  Api.MessageEntityMention({ offset: 3, length: 6 }),
                  Api.InputMessageEntityMentionName({
                    offset: 10,
                    length: 3,
                    userId: Api.InputUser({ userId: 405n, accessHash: 77n }),
                  }),
                ]);
                return Api.Updates({ updates: [], users: [], chats: [], date: 1, seq: 1 });
              })) as MtprotoClient['invoke'],
          }),
        ),
    ),
  ));
