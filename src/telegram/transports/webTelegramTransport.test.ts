import { zlibSync, strToU8 } from 'fflate';
import { SecureRandom, Digest, Kdf } from 'effect/crypto';
import { Effect, Fiber, PubSub, Stream } from 'effect';
import * as Socket from 'effect/socket/Socket';
import { describe, expect, it, vi } from 'vitest';

import type { CreateMtprotoClientOptions, MtprotoClient } from '../mtproto';
import { updateEvent, type MtprotoClientEvent } from '../mtproto/events';
import { createMtprotoError } from '../mtproto/errors';
import { Api, createTl, encodeTl, decodeTl } from '../mtproto/tl';
import { makeMemoryCacheStore } from '../persistence/memoryStore';
import { createWebTelegramTransport } from './webTelegramTransport';

const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(1));
const unusedSocket = (() => {
  throw new Error('Unexpected WebSocket construction.');
}) as Socket.WebSocketConstructor['Service'];

const providePlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(SecureRandom.SecureRandom, testCrypto),
    Effect.provide(Digest.layerWebCrypto),
    Effect.provideService(Socket.WebSocketConstructor, unusedSocket),
  ) as Effect.Effect<
    A,
    E,
    Exclude<R, (SecureRandom.SecureRandom | Digest.Digest | Kdf.Kdf) | Socket.WebSocketConstructor>
  >;

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
  switchDc: () => Effect.void,
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
  it('decodes rich document pairs and downloads each document by its own identity', () => {
    const documents = [1n, 2n].map((id) =>
      Api.Document({
        id,
        accessHash: id + 100n,
        fileReference: new Uint8Array([Number(id)]),
        date: 1,
        dcId: 2,
        size: 3n,
        mimeType: 'text/plain',
        attributes: [
          Api.DocumentAttributeFilename({ fileName: id === 1n ? 'aaa.txt' : 'bbb.txt' }),
        ],
      }),
    );
    const source = Api.Message({
      id: 42,
      peerId: Api.PeerUser({ userId: 101n }),
      date: 1,
      message: '',
      richMessage: Api.RichMessage({
        documents,
        photos: [],
        blocks: documents.map((document, index) =>
          Api.PageBlockDocument({
            documentId: document.id,
            caption: Api.PageCaption({
              text: Api.TextPlain({ text: index ? 'БББ' : 'AAA' }),
              credit: Api.TextEmpty(),
            }),
          }),
        ),
      }),
      replyMarkup: Api.ReplyInlineMarkup({
        forceReply: true,
        rows: [
          Api.KeyboardInlineButtonRow({
            buttons: [
              Api.KeyboardInlineButton({
                text: 'Back',
                type: Api.InlineButtonTypeCallback({ data: new Uint8Array([7]) }),
              }),
              Api.KeyboardInlineButton({
                text: 'Copy',
                type: Api.InlineButtonTypeCopy({ copyText: 'value' }),
              }),
            ],
          }),
        ],
      }),
    });
    const decoded = decodeTl(encodeTl(source));
    expect(decoded).toEqual(source);
    const download = vi.fn((media: unknown) => {
      if (!Api.MessageMediaDocument.is(media) || !Api.Document.is(media.document))
        throw Error('Wrong download target');
      return Effect.succeed(new Uint8Array([Number(media.document.id), 0, 0]));
    });
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const page = yield* transport.getHistory(
              { id: 'u:101', kind: 'user', accessHash: '1' },
              10,
            );
            const message = page.messages[0]!;
            expect(message.botKeyboard?.forceReply).toBe(true);
            expect(message.botKeyboard?.rows[0]).toEqual([
              { kind: 'callback', text: 'Back', data: [7] },
              { kind: 'copy', text: 'Copy', copyText: 'value' },
            ]);
            expect(message.richMessage?.blocks).toHaveLength(2);
            for (const [index, block] of message.richMessage!.blocks.entries()) {
              expect(block).toMatchObject({
                kind: 'media',
                mediaKind: 'file',
                attachment: { name: index ? 'bbb.txt' : 'aaa.txt', size: 3 },
                caption: { text: { text: index ? 'БББ' : 'AAA' } },
              });
              if (block.kind !== 'media' || !block.attachment) throw Error('Missing attachment');
              const blob = yield* transport.downloadMedia({ ...message, media: block.attachment });
              expect(new Uint8Array(yield* Effect.promise(() => blob.arrayBuffer()))[0]).toBe(
                index + 1,
              );
            }
            expect(download).toHaveBeenCalledTimes(2);
          }),
        () =>
          Effect.succeed(
            clientDouble({
              downloadMedia: download,
              invoke: (() =>
                Effect.succeed(
                  Api.messages.Messages({ messages: [source], topics: [], users: [], chats: [] }),
                )) as MtprotoClient['invoke'],
            }),
          ),
      ),
    );
  });

  it('decodes widget payloads and sends message-scoped data queries and stop-draft actions', () => {
    const peer = { id: 'u:101', kind: 'user' as const, accessHash: '1' };
    const source = Api.Message({
      id: 43,
      peerId: Api.PeerUser({ userId: 101n }),
      date: 1,
      message: '',
      media: Api.MessageMediaWidget({
        width: 320,
        height: 160,
        canQuery: true,
        payload: zlibSync(strToU8('<p>Hello widget</p>')),
        chatData: 'chat state',
        publicData: 'public state',
        publicDataHash: 1n,
      }),
    });
    expect(decodeTl(encodeTl(source))).toEqual(source);
    const calls: unknown[] = [];
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const page = yield* transport.getHistory(peer, 10);
            expect(page.messages[0]?.widget).toMatchObject({
              html: '<p>Hello widget</p>',
              width: 320,
              height: 160,
              canQuery: true,
              isCopy: false,
              chatData: 'chat state',
              publicData: 'public state',
            });
            expect(page.messages[0]?.contentDiagnostic?.outcome).toBe('mapped');
            expect(yield* transport.queryWidget(peer, 43, 'ping')).toBe('pong');
            yield* transport.stopLiveDraft(peer, '123', 7);
            expect(calls).toContainEqual(
              Api.messages.GetBotWidgetQueryAnswer({
                peer: Api.InputPeerUser({ userId: 101n, accessHash: 1n }),
                msgId: 43,
                queryType: Api.WidgetQueryTypeData({}),
                data: strToU8('ping'),
              }),
            );
            expect(calls).toContainEqual(
              Api.messages.SetTyping({
                peer: Api.InputPeerUser({ userId: 101n, accessHash: 1n }),
                topMsgId: 7,
                action: Api.SendMessageStopDraftAction({ randomId: 123n }),
              }),
            );
          }),
        () =>
          Effect.succeed(
            clientDouble({
              invoke: ((request: unknown) => {
                calls.push(request);
                if (Api.messages.GetBotWidgetQueryAnswer.is(request))
                  return Effect.succeed(
                    createTl('messages.botWidgetQueryAnswer', { result: 'pong' }),
                  );
                if (Api.messages.SetTyping.is(request)) return Effect.succeed(true);
                return Effect.succeed(
                  Api.messages.Messages({ messages: [source], topics: [], users: [], chats: [] }),
                );
              }) as MtprotoClient['invoke'],
            }),
          ),
      ),
    );
  });

  it('retains source content evidence for unsupported messages and grouped TXT files', () => {
    const messages = [
      Api.Message({
        id: 1,
        peerId: Api.PeerUser({ userId: 101n }),
        date: 1,
        message: '',
        media: createTl('messageMediaUnsupported', {}),
      }),
      ...['AAA', 'БББ'].map((caption, index) =>
        Api.Message({
          id: index + 2,
          peerId: Api.PeerUser({ userId: 101n }),
          date: 1,
          message: caption,
          groupedId: 123n,
          media: Api.MessageMediaDocument({
            document: Api.Document({
              id: BigInt(index + 1),
              accessHash: 123456n,
              fileReference: new Uint8Array([1, 2]),
              date: 1,
              mimeType: 'text/plain',
              size: 3n,
              dcId: 2,
              attributes: [Api.DocumentAttributeFilename({ fileName: `private-${index}.txt` })],
            }),
          }),
        }),
      ),
      Api.Message({ id: 4, peerId: Api.PeerUser({ userId: 101n }), date: 1, message: '' }),
    ];
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const result = yield* transport.getHistory(
              { id: 'u:101', kind: 'user', accessHash: '1' },
              10,
            );
            const unsupported = result.messages.find((message) => message.id === 1)!;
            expect(unsupported.contentDiagnostic).toMatchObject({
              outcome: 'server-unsupported',
              textLength: 0,
              mappedMedia: false,
            });
            expect(unsupported.contentDiagnostic?.mediaConstructor).toBeDefined();
            for (const id of [2, 3]) {
              const file = result.messages.find((message) => message.id === id)!;
              expect(file.media).toMatchObject({ kind: 'file', mimeType: 'text/plain', size: 3 });
              expect(file.contentDiagnostic).toMatchObject({
                outcome: 'mapped',
                grouped: true,
                textLength: 3,
                mappedMedia: true,
              });
              expect(file.contentDiagnostic?.documentAttributes).toHaveLength(1);
              expect(JSON.stringify(file.contentDiagnostic)).not.toMatch(
                /private|123456|fileReference/,
              );
            }
            expect(
              result.messages.find((message) => message.id === 4)?.contentDiagnostic?.outcome,
            ).toBe('empty-source');
          }),
        () =>
          Effect.succeed(
            clientDouble({
              invoke: (() =>
                Effect.succeed(
                  Api.messages.Messages({ messages, users: [], chats: [], topics: [] }),
                )) as MtprotoClient['invoke'],
            }),
          ),
      ),
    );
  });

  it('preserves streamed text entities and rich draft updates instead of converting them to typing', () =>
    Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const events = yield* PubSub.sliding<MtprotoClientEvent>(8);
            const transport = yield* createWebTelegramTransport(makeMemoryCacheStore(), {
              createClient: () =>
                Effect.succeed(clientDouble({ events: Stream.fromPubSub(events) })),
            });
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const received = yield* transport.updates.pipe(
              Stream.take(2),
              Stream.runCollect,
              Effect.forkChild({ startImmediately: true }),
            );
            yield* PubSub.publish(
              events,
              updateEvent(
                Api.UpdateUserTyping({
                  userId: 606n,
                  topMsgId: 42,
                  action: Api.SendMessageTextDraftAction({
                    randomId: 9223372036854775806n,
                    text: Api.TextWithEntities({
                      text: '/usersCount',
                      entities: [Api.MessageEntityBotCommand({ offset: 0, length: 11 })],
                    }),
                  }),
                }),
              ),
            );
            yield* PubSub.publish(
              events,
              updateEvent(
                Api.UpdateUserTyping({
                  userId: 606n,
                  topMsgId: 42,
                  action: Api.SendMessageRichMessageDraftAction({
                    randomId: 9223372036854775806n,
                    richMessage: Api.RichMessage({
                      blocks: [
                        Api.PageBlockParagraph({
                          text: Api.TextBotCommand({ text: Api.TextPlain({ text: '/help' }) }),
                        }),
                      ],
                      photos: [],
                      documents: [],
                    }),
                  }),
                }),
              ),
            );
            const batches = Array.from(yield* Fiber.join(received));
            expect(batches[0]?.updates).toMatchObject([
              {
                type: 'live-draft',
                draft: {
                  id: 'u:606:42:9223372036854775806',
                  peerId: 'u:606',
                  topicId: 42,
                  text: '/usersCount',
                  formats: [{ kind: 'botCommand', offset: 0, length: 11 }],
                },
              },
            ]);
            expect(batches[1]?.updates).toMatchObject([
              {
                type: 'live-draft',
                draft: {
                  id: 'u:606:42:9223372036854775806',
                  richMessage: {
                    blocks: [{ kind: 'text', text: { kind: 'command', command: '/help' } }],
                  },
                },
              },
            ]);
          }),
        ),
      ),
    ));

  it('keeps migrated basic groups read-only even for their owner', () => {
    const invoke = (request: unknown) => {
      if (!Api.messages.GetPeerDialogs.is(request))
        return Effect.fail(createMtprotoError('rpc', 'Unused enrichment'));
      return Effect.succeed(
        createTl('messages.peerDialogs', {
          dialogs: [
            createTl('dialog', {
              peer: Api.PeerChat({ chatId: 303n }),
              topMessage: 0,
              readInboxMaxId: 0,
              readOutboxMaxId: 0,
              unreadCount: 0,
              unreadMentionsCount: 0,
              unreadReactionsCount: 0,
              notifySettings: createTl('peerNotifySettings', {}),
            }),
          ],
          messages: [],
          users: [],
          chats: [
            createTl('chat', {
              id: 303n,
              title: 'Old group',
              creator: true,
              deactivated: true,
              migratedTo: Api.InputChannel({ channelId: 707n, accessHash: 9n }),
              photo: Api.ChatPhotoEmpty({}),
              participantsCount: 2,
              date: 1,
              version: 1,
            }),
          ],
          state: createTl('updates.state', { pts: 1, qts: 0, date: 1, seq: 1, unreadCount: 0 }),
        }),
      );
    };
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const dialog = yield* transport.getDialog!({ id: 'g:303', kind: 'group' });
            expect(dialog?.permissions?.canSendMessages).toBe(false);
            expect(dialog?.permissions?.canEditMessages).toBe(false);
            expect(dialog?.permissions?.canManageChat).not.toBe(true);
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });

  it.each([true, false])('sends the correct approval flag for a join request (%s)', (approved) => {
    const invoke = vi.fn((request: unknown) => {
      expect(Api.messages.HideChatJoinRequest.is(request)).toBe(true);
      expect(request).toMatchObject({
        peer: { channelId: 202n, accessHash: 5n },
        userId: { userId: 101n, accessHash: 7n },
      });
      if (approved) expect(request).toHaveProperty('approved', true);
      else expect(request).not.toHaveProperty('approved');
      return Effect.succeed(Api.Updates({ updates: [], users: [], chats: [], seq: 1, date: 1 }));
    });
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            yield* transport.resolveJoinRequest!(
              { id: 'c:202', kind: 'channel', accessHash: '5' },
              { id: 'u:101', kind: 'user', accessHash: '7' },
              approved,
            );
            expect(invoke).toHaveBeenCalledTimes(1);
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });
  it('paginates join requests by the server date and user cursor', () => {
    const invoke = vi.fn((request: unknown) => {
      expect(request).toMatchObject({
        requested: true,
        q: 'Nina',
        offsetDate: 200,
        offsetUser: { userId: 101n, accessHash: 7n },
        limit: 50,
      });
      return Effect.succeed(
        createTl('messages.chatInviteImporters', {
          count: 51,
          importers: Array.from({ length: 50 }, (_, index) =>
            createTl('chatInviteImporter', {
              userId: BigInt(index + 1),
              date: 100 - index,
              requested: true as const,
              about: 'Hello',
            }),
          ),
          users: [],
        }),
      );
    });
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const page = yield* transport.getJoinRequests!(
              { id: 'c:202', kind: 'channel', accessHash: '5' },
              ' Nina ',
              { date: 200, user: { id: 'u:101', kind: 'user', accessHash: '7' } },
            );
            expect(page.people).toHaveLength(50);
            expect(page.nextOffset).toMatchObject({ date: 51, user: { id: 'u:50' } });
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });

  it('recognizes an approval request from the structured RPC error without claiming membership', () => {
    const invoke = vi.fn(() =>
      Effect.fail(
        createMtprotoError('rpc', 'Telegram RPC failed: INVITE_REQUEST_SENT', {
          code: 400,
          details: { errorMessage: 'INVITE_REQUEST_SENT' },
        }),
      ),
    );
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            expect(yield* transport.joinChatInvite!('request')).toEqual({ status: 'requested' });
            expect(invoke).toHaveBeenCalledTimes(1);
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });
  it('reads invitation approval and subscription requirements without joining', () => {
    const invoke = vi.fn((request: unknown) => {
      expect(Api.messages.CheckChatInvite.is(request)).toBe(true);
      return Effect.succeed(
        createTl('chatInvite', {
          title: 'Plans',
          about: 'Welcome',
          photo: createTl('photoEmpty', { id: 0n }),
          participantsCount: 42,
          color: 1,
          requestNeeded: true as const,
          broadcast: true as const,
          subscriptionPricing: createTl('starsSubscriptionPricing', {
            period: 2592000,
            amount: 100n,
          }),
        }),
      );
    });
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            expect(yield* transport.checkChatInvite!('invite')).toMatchObject({
              title: 'Plans',
              participantsCount: 42,
              requestNeeded: true,
              paid: true,
              alreadyJoined: false,
            });
            expect(invoke).toHaveBeenCalledTimes(1);
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });
  it('unwraps the current-layer invitation join result and remembers the new peer access hash', () => {
    const invoke = vi.fn(() =>
      Effect.succeed(
        createTl('messages.chatInviteJoinResultOk', {
          updates: Api.Updates({
            updates: [],
            users: [],
            chats: [
              createTl('channel', {
                id: 6000n,
                accessHash: 66n,
                title: 'Plans',
                photo: Api.ChatPhotoEmpty({}),
                date: 100,
              }),
            ],
            date: 100,
            seq: 1,
          }),
        }),
      ),
    );
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            expect(yield* transport.joinChatInvite!('invite')).toMatchObject({
              status: 'joined',
              peer: { id: 'c:6000', accessHash: '66' },
            });
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });

  it.each(['group', 'channel'] as const)(
    'creates a %s and preserves partial invitation results',
    (kind) => {
      const invoke = vi.fn((request: unknown) => {
        if (kind === 'group') {
          expect(Api.messages.CreateChat.is(request)).toBe(true);
          expect(request).toMatchObject({
            title: 'Weekend',
            users: [{ userId: 101n, accessHash: 5n }],
          });
        } else {
          expect(Api.channels.CreateChannel.is(request)).toBe(true);
          expect(request).toMatchObject({ title: 'Weekend', about: 'Plans', broadcast: true });
        }
        const chats =
          kind === 'group'
            ? [
                createTl('chat', {
                  id: 5000n,
                  title: 'Weekend',
                  creator: true as const,
                  photo: Api.ChatPhotoEmpty({}),
                  participantsCount: 2,
                  date: 100,
                  version: 1,
                }),
              ]
            : [
                createTl('channel', {
                  id: 5000n,
                  accessHash: 99n,
                  title: 'Weekend',
                  creator: true as const,
                  broadcast: true as const,
                  photo: Api.ChatPhotoEmpty({}),
                  date: 100,
                }),
              ];
        const updates = Api.Updates({ updates: [], chats, users: [], date: 100, seq: 1 });
        return Effect.succeed(
          kind === 'group'
            ? createTl('messages.invitedUsers', {
                updates,
                missingInvitees: [createTl('missingInvitee', { userId: 101n })],
              })
            : updates,
        );
      });
      return Effect.runPromise(
        withTransport(
          (transport) =>
            Effect.gen(function* () {
              yield* transport.connect({ apiId: 1, apiHash: 'hash' });
              const result = yield* transport.createChat!({
                kind,
                title: 'Weekend',
                about: 'Plans',
                users: [{ id: 'u:101', kind: 'user', accessHash: '5' }],
              });
              expect(result.peer).toMatchObject({
                id: kind === 'group' ? 'g:5000' : 'c:5000',
                kind,
              });
              if (kind === 'channel') expect(result.peer.accessHash).toBe('99');
              expect(result.missingUserIds).toEqual(kind === 'group' ? ['u:101'] : []);
              expect(invoke).toHaveBeenCalledTimes(1);
            }),
          () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
        ),
      );
    },
  );

  it('searches participants with a server cursor even when an entity is unavailable', () => {
    const invoke = vi.fn((_request: unknown) =>
      Effect.succeed(
        Api.channels.ChannelParticipants({
          count: 4,
          participants: [Api.ChannelParticipant({ userId: 10n, date: 1 })],
          users: [],
          chats: [],
        }),
      ),
    );
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const page = yield* transport.getGroupMembers!(
              { id: 'c:1', kind: 'channel', accessHash: '2' },
              1,
              2,
              ' Alice ',
            );
            expect(invoke.mock.calls[0]?.[0]).toMatchObject({
              filter: Api.ChannelParticipantsSearch({ q: 'Alice' }),
              offset: 2,
              limit: 1,
            });
            expect(page).toEqual({ members: [], totalCount: 4, hasMore: true, nextOffset: 3 });
          }),
        () =>
          Effect.succeed(clientDouble({ invoke: invoke as unknown as MtprotoClient['invoke'] })),
      ),
    );
  });
  it('stops participant pagination when Telegram returns an empty page with a stale count', () => {
    const invoke = vi.fn((_request: unknown) =>
      Effect.succeed(
        Api.channels.ChannelParticipants({ count: 4, participants: [], users: [], chats: [] }),
      ),
    );
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const page = yield* transport.getGroupMembers!(
              { id: 'c:1', kind: 'channel', accessHash: '2' },
              50,
              0,
              '',
            );
            expect(page).toEqual({ members: [], totalCount: 4, hasMore: false });
          }),
        () =>
          Effect.succeed(clientDouble({ invoke: invoke as unknown as MtprotoClient['invoke'] })),
      ),
    );
  });

  it.each([
    ['happy cats', 'happy cats', ''],
    ['👍🎉', '', '👍 🎉'],
    ['🇷🇺', '', '🇷🇺'],
  ])(
    'searches individual stickers for %s with the appropriate query fields',
    (query, q, emoticon) => {
      const invoke = vi.fn((_request: unknown) =>
        Effect.succeed(Api.messages.FoundStickers({ hash: 0n, stickers: [], nextOffset: 10 })),
      );
      return Effect.runPromise(
        withTransport(
          (transport) =>
            Effect.gen(function* () {
              yield* transport.connect({ apiId: 1, apiHash: 'hash' });
              const page = yield* transport.searchStickers!(query, 0);
              expect(page.nextOffset).toBe(10);
              expect(invoke.mock.calls[0]?.[0]).toMatchObject({
                q,
                emoticon,
                offset: 0,
                limit: 50,
                langCode: [],
              });
              const last = yield* transport.searchStickers!(query, 10);
              expect(last.nextOffset).toBeUndefined();
            }),
          () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
        ),
      );
    },
  );

  it('loads pack metadata and installs or removes its exact Telegram identity', () => {
    const set = Api.StickerSet({
      id: 9223372036854775806n,
      accessHash: 9223372036854775805n,
      title: 'Cats',
      shortName: 'CatsPack',
      count: 3,
      hash: 1,
      installedDate: 1700000000,
    });
    const invoke = vi.fn((request: unknown) => {
      if (Api.messages.GetStickerSet.is(request))
        return Effect.succeed(
          Api.messages.StickerSet({ set, documents: [], packs: [], keywords: [] }),
        );
      if (Api.messages.InstallStickerSet.is(request))
        return Effect.succeed(Api.messages.StickerSetInstallResultSuccess());
      return Effect.succeed(true);
    });
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const pack = yield* transport.getStickerPack!('CatsPack');
            expect(pack).toMatchObject({
              id: '9223372036854775806',
              accessHash: '9223372036854775805',
              shortName: 'CatsPack',
              installed: true,
              count: 3,
            });
            yield* transport.setStickerPackInstalled!(pack, false);
            yield* transport.setStickerPackInstalled!(pack, true);
            expect(Api.messages.UninstallStickerSet.is(invoke.mock.calls[1]?.[0])).toBe(true);
            expect(invoke.mock.calls[2]?.[0]).toMatchObject({
              archived: false,
              stickerset: { id: 9223372036854775806n, accessHash: 9223372036854775805n },
            });
            const invalid = yield* transport.getStickerPack!('../bad').pipe(Effect.result);
            expect(invalid._tag).toBe('Failure');
            expect(invoke).toHaveBeenCalledTimes(3);
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });

  it.each([true, false])(
    'sets server sticker favorite=%s using full document identity',
    (favorite) => {
      const invoke = vi.fn((_request: unknown) => Effect.succeed(true));
      return Effect.runPromise(
        withTransport(
          (transport) =>
            Effect.gen(function* () {
              yield* transport.connect({ apiId: 1, apiHash: 'hash' });
              yield* transport.setStickerFavorite!(
                {
                  id: '9223372036854775806',
                  accessHash: '9223372036854775805',
                  fileReference: new Uint8Array([1, 2]),
                  emoji: '⭐',
                  mimeType: 'image/webp',
                },
                favorite,
              );
              const request = invoke.mock.calls[0]?.[0];
              expect(Api.messages.FaveSticker.is(request)).toBe(true);
              expect(request).toMatchObject({
                unfave: !favorite,
                id: {
                  id: 9223372036854775806n,
                  accessHash: 9223372036854775805n,
                  fileReference: new Uint8Array([1, 2]),
                },
              });
            }),
          () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
        ),
      );
    },
  );

  it('passes media, sender, dates and pagination to Telegram instead of filtering a loaded page', () => {
    const invoke = vi.fn((_request: unknown) =>
      Effect.succeed(Api.messages.Messages({ messages: [], topics: [], users: [], chats: [] })),
    );
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            yield* transport.searchMessages(
              '',
              { id: 'g:303', kind: 'group' },
              50,
              { messageId: 42 },
              {
                kind: 'photos',
                topicId: 10,
                fromPeer: { id: 'u:101', kind: 'user', accessHash: '123' },
                minDate: 1700000000,
                maxDate: 1700086399,
              },
            );
            const request = invoke.mock.calls[0]?.[0];
            expect(Api.messages.Search.is(request)).toBe(true);
            expect(request).toMatchObject({
              peer: { chatId: 303n },
              fromId: { userId: 101n, accessHash: 123n },
              q: '',
              minDate: 1700000000,
              maxDate: 1700086399,
              offsetId: 42,
              topMsgId: 10,
              limit: 51,
            });
            if (Api.messages.Search.is(request))
              expect(Api.InputMessagesFilterPhotos.is(request.filter)).toBe(true);
            yield* transport.searchMessages(
              'budget',
              undefined,
              50,
              { messageId: 9, rate: 12, peer: { id: 'g:303', kind: 'group' } },
              { kind: 'files', chatType: 'groups', minDate: 1700000000 },
            );
            const global = invoke.mock.calls[1]?.[0];
            expect(Api.messages.SearchGlobal.is(global)).toBe(true);
            expect(global).toMatchObject({
              groupsOnly: true,
              q: 'budget',
              offsetId: 9,
              offsetRate: 12,
              minDate: 1700000000,
              maxDate: 0,
            });
            if (Api.messages.SearchGlobal.is(global)) {
              expect(Api.InputMessagesFilterDocument.is(global.filter)).toBe(true);
              expect(global.usersOnly).toBeUndefined();
              expect(global.broadcastsOnly).toBeUndefined();
            }
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });

  it.each([false, true])(
    'opens named Mini Apps and grants write access only when selected: %s',
    (writeAllowed) => {
      const invoke = vi.fn((_request: unknown) =>
        Effect.succeed(Api.WebViewResultUrl({ url: 'https://mini.test/#signed' })),
      );
      return Effect.runPromise(
        withTransport(
          (transport) =>
            Effect.gen(function* () {
              yield* transport.connect({ apiId: 1, apiHash: 'hash' });
              const bot = { id: 'u:101', kind: 'user' as const, accessHash: '123' };
              yield* transport.requestWebApp!({
                peer: { id: 'g:303', kind: 'group' },
                bot,
                mode: 'app',
                app: { id: '9223372036854775806', accessHash: '9223372036854775805' },
                startParam: 'order_123',
                displayMode: 'compact',
                writeAllowed,
                theme: {},
              });
              const request = invoke.mock.calls[0]?.[0];
              expect(Api.messages.RequestAppWebView.is(request)).toBe(true);
              expect(request).toMatchObject({
                peer: { chatId: 303n },
                app: { id: 9223372036854775806n, accessHash: 9223372036854775805n },
                startParam: 'order_123',
                compact: true,
              });
              if (Api.messages.RequestAppWebView.is(request))
                expect(request.writeAllowed).toBe(writeAllowed ? true : undefined);
            }),
          () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
        ),
      );
    },
  );

  it('maps Mini App completion updates with full query id precision', () =>
    Effect.runPromise(
      Effect.scoped(
        providePlatform(
          Effect.gen(function* () {
            const events = yield* PubSub.sliding<MtprotoClientEvent>(8);
            const transport = yield* createWebTelegramTransport(makeMemoryCacheStore(), {
              createClient: () =>
                Effect.succeed(clientDouble({ events: Stream.fromPubSub(events) })),
            });
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const received = yield* transport.updates.pipe(
              Stream.runHead,
              Effect.forkChild({ startImmediately: true }),
            );
            yield* PubSub.publish(
              events,
              updateEvent(Api.UpdateWebViewResultSent({ queryId: 9223372036854775806n })),
            );
            const result = yield* Fiber.join(received);
            expect(result._tag).toBe('Some');
            if (result._tag === 'Some')
              expect(result.value.updates).toEqual([
                { type: 'web-app-result', queryId: '9223372036854775806' },
              ]);
          }),
        ),
      ),
    ));

  it.each(['simple', 'inline', 'menu', 'main'] as const)(
    'launches %s Mini Apps with the appropriate RPC and preserves 64-bit query ids',
    (mode) => {
      const invoke = vi.fn((_request: unknown) =>
        Effect.succeed(
          Api.WebViewResultUrl({
            url: 'https://mini.test/#tgWebAppData=signed',
            queryId: 9223372036854775806n,
          }),
        ),
      );
      return Effect.runPromise(
        withTransport(
          (transport) =>
            Effect.gen(function* () {
              yield* transport.connect({ apiId: 1, apiHash: 'hash' });
              const peer = { id: 'u:101', kind: 'user' as const, accessHash: '123' };
              const result = yield* transport.requestWebApp!({
                peer,
                bot: peer,
                mode,
                url: 'https://mini.test/',
                theme: { bg_color: '#ffffff' },
              });
              expect(result.queryId).toBe('9223372036854775806');
              const request = invoke.mock.calls[0]?.[0];
              if (mode === 'simple')
                expect(Api.messages.RequestSimpleWebView.is(request)).toBe(true);
              else if (mode === 'main')
                expect(Api.messages.RequestMainWebView.is(request)).toBe(true);
              else expect(Api.messages.RequestWebView.is(request)).toBe(true);
              expect(request).toMatchObject({
                platform: 'web',
                bot: { userId: 101n, accessHash: 123n },
              });
              if (mode === 'menu') expect(request).toMatchObject({ fromBotMenu: true });
            }),
          () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
        ),
      );
    },
  );
  it('rejects unsafe Mini App links and oversized UTF-8 data before issuing an RPC', () => {
    const invoke = vi.fn((_request: unknown) => Effect.succeed(true));
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const bot = { id: 'u:101', kind: 'user' as const };
            expect(
              (yield* transport.requestWebApp!({
                peer: bot,
                bot,
                mode: 'simple',
                url: 'javascript:alert(1)',
                theme: {},
              }).pipe(Effect.result))._tag,
            ).toBe('Failure');
            expect(
              (yield* transport.sendWebAppData!(bot, 'Open', '🙂'.repeat(1025), '1').pipe(
                Effect.result,
              ))._tag,
            ).toBe('Failure');
            expect(invoke).not.toHaveBeenCalled();
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });

  it('reads current privacy before saving and keeps exceptions from other clients', () => {
    const requests: unknown[] = [];
    const current = Api.account.PrivacyRules({
      rules: [
        Api.PrivacyValueDisallowUsers({ users: [101n] }),
        Api.PrivacyValueAllowPremium(),
        Api.PrivacyValueAllowAll(),
      ],
      users: [Api.User({ id: 101n, accessHash: 9223372036854775806n, firstName: 'Alice' })],
      chats: [],
    });
    const invoke = (request: unknown) => {
      requests.push(request);
      return Effect.succeed(current);
    };
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            yield* transport.setPrivacy!('phone-number', { audience: 'contacts' });
            expect(Api.account.GetPrivacy.is(requests[0])).toBe(true);
            const write = requests[1];
            expect(Api.account.SetPrivacy.is(write)).toBe(true);
            if (Api.account.SetPrivacy.is(write)) {
              expect(write.rules).toHaveLength(4);
              expect(write.rules[0]).toMatchObject({
                users: [{ userId: 101n, accessHash: 9223372036854775806n }],
              });
              expect(Api.InputPrivacyValueAllowPremium.is(write.rules[1])).toBe(true);
              expect(Api.InputPrivacyValueAllowContacts.is(write.rules[2])).toBe(true);
              expect(Api.InputPrivacyValueDisallowAll.is(write.rules[3])).toBe(true);
            }
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });
  it('changes read-time privacy without resetting unrelated global privacy flags', () => {
    const current = Api.GlobalPrivacySettings({
      hideReadMarks: true,
      archiveAndMuteNewNoncontactPeers: true,
      newNoncontactPeersRequirePremium: true,
      noncontactPeersPaidStars: 123n,
    });
    const invoke = (request: unknown) => {
      if (Api.account.GetGlobalPrivacySettings.is(request)) return Effect.succeed(current);
      expect(Api.account.SetGlobalPrivacySettings.is(request)).toBe(true);
      if (Api.account.SetGlobalPrivacySettings.is(request)) {
        expect(request.settings).toMatchObject({
          archiveAndMuteNewNoncontactPeers: true,
          newNoncontactPeersRequirePremium: true,
          noncontactPeersPaidStars: 123n,
        });
        expect(request.settings.hideReadMarks).toBeUndefined();
        return Effect.succeed(request.settings);
      }
      return Effect.succeed(current);
    };
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            expect(yield* transport.setReadTimePrivacy!(false)).toBe(false);
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });

  it('maps active devices without losing 64-bit authorization hashes', () => {
    const invoke = (request: unknown) => {
      expect(Api.account.GetAuthorizations.is(request)).toBe(true);
      const fields = {
        deviceModel: 'Desktop',
        platform: 'Linux',
        systemVersion: '6',
        apiId: 1,
        appName: 'TeleVecha',
        appVersion: '0.1',
        dateCreated: 100,
        dateActive: 200,
        ip: '192.0.2.1',
        country: 'Fixture',
        region: 'Test',
      };
      return Effect.succeed(
        Api.account.Authorizations({
          authorizationTtlDays: 180,
          authorizations: [
            Api.Authorization({ ...fields, hash: 9223372036854775806n }),
            Api.Authorization({ ...fields, hash: 0n, current: true }),
          ],
        }),
      );
    };
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const page = yield* transport.getActiveSessions!();
            expect(page.ttlDays).toBe(180);
            expect(page.sessions[0]).toMatchObject({ id: '0', current: true });
            expect(page.sessions[1]).toMatchObject({
              id: '9223372036854775806',
              device: 'Desktop',
              ip: '192.0.2.1',
              activeAt: 200,
            });
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });
  it('uses distinct RPCs for one device, all other devices and expiry', () => {
    const invoke = vi.fn((_request: unknown) => Effect.succeed(true));
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            yield* transport.terminateSession!('-9223372036854775807');
            yield* transport.terminateSession!();
            yield* transport.setSessionTtl!(30);
            expect(invoke.mock.calls[0]?.[0]).toMatchObject({ hash: -9223372036854775807n });
            expect(Api.account.ResetAuthorization.is(invoke.mock.calls[0]?.[0])).toBe(true);
            expect(Api.auth.ResetAuthorizations.is(invoke.mock.calls[1]?.[0])).toBe(true);
            expect(invoke.mock.calls[2]?.[0]).toMatchObject({ authorizationTtlDays: 30 });
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });
  it('explains the restriction on terminating sessions immediately after login', () =>
    Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const result = yield* transport.terminateSession!('123').pipe(Effect.result);
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') expect(result.failure.message).toContain('24 hours');
          }),
        () =>
          Effect.succeed(
            clientDouble({
              invoke: (() =>
                Effect.fail(
                  createMtprotoError('rpc', 'FRESH_RESET_AUTHORISATION_FORBIDDEN', {
                    code: 406,
                    details: { errorMessage: 'FRESH_RESET_AUTHORISATION_FORBIDDEN' },
                  }),
                )) as MtprotoClient['invoke'],
            }),
          ),
      ),
    ));

  it.each([
    ['MESSAGE_NOT_READ_YET', 'unread'],
    ['MESSAGE_TOO_OLD', 'expired'],
    ['MSG_TOO_OLD', 'expired'],
    ['USER_PRIVACY_RESTRICTED', 'privacy'],
    ['YOUR_PRIVACY_RESTRICTED', 'own-privacy'],
    ['CHAT_TOO_BIG', 'too-large'],
  ] as const)('distinguishes read receipt limitation %s', (errorMessage, state) =>
    Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            expect(
              yield* transport.getMessageReadReceipts!(
                { id: 'u:101', kind: 'user', accessHash: '1' },
                42,
              ),
            ).toEqual({ state, people: [] });
          }),
        () =>
          Effect.succeed(
            clientDouble({
              invoke: (() =>
                Effect.fail(
                  createMtprotoError('rpc', errorMessage, { code: 400, details: { errorMessage } }),
                )) as MtprotoClient['invoke'],
            }),
          ),
      ),
    ),
  );

  it.each(['user', 'group'] as const)(
    'loads names, avatars and exact read times for a %s',
    (kind) => {
      const invoke = (request: unknown) => {
        if (Api.messages.GetHistory.is(request))
          return Effect.succeed(
            Api.messages.Messages({
              messages: [],
              topics: [],
              chats: [],
              users: [
                Api.User({
                  id: 101n,
                  accessHash: 1n,
                  firstName: 'Alice',
                  photo: Api.UserProfilePhoto({ photoId: 7n, dcId: 2 }),
                }),
                Api.User({ id: 102n, accessHash: 2n, firstName: 'Bob' }),
              ],
            }),
          );
        if (kind === 'user') {
          expect(Api.messages.GetOutboxReadDate.is(request)).toBe(true);
          return Effect.succeed(Api.OutboxReadDate({ date: 123 }));
        }
        expect(Api.messages.GetMessageReadParticipants.is(request)).toBe(true);
        return Effect.succeed([
          Api.ReadParticipantDate({ userId: 101n, date: 123 }),
          Api.ReadParticipantDate({ userId: 102n, date: 124 }),
        ]);
      };
      return Effect.runPromise(
        withTransport(
          (transport) =>
            Effect.gen(function* () {
              yield* transport.connect({ apiId: 1, apiHash: 'hash' });
              const peer = { id: kind === 'user' ? 'u:101' : 'g:303', kind, accessHash: '1' };
              yield* transport.getHistory(peer, 10);
              const result = yield* transport.getMessageReadReceipts!(peer, 42);
              expect(result.state).toBe('available');
              expect(result.people.find((person) => person.id === 'u:101')).toMatchObject({
                name: 'Alice',
                readAt: 123,
                hasAvatar: true,
                avatarId: '7',
              });
              if (kind === 'group')
                expect(result.people.map((person) => person.name)).toEqual(['Bob', 'Alice']);
            }),
          () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
        ),
      );
    },
  );

  it.each([
    ['BROADCAST_FORBIDDEN', 'broadcast'],
    ['POLL_VOTE_REQUIRED', 'vote-required'],
    ['MSG_ID_INVALID', 'deleted'],
  ] as const)('explains the poll results restriction %s', (errorMessage, unavailable) =>
    Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            expect(yield* transport.getPollVotes!({ id: 'g:303', kind: 'group' }, 42)).toEqual({
              people: [],
              count: 0,
              unavailable,
            });
          }),
        () =>
          Effect.succeed(
            clientDouble({
              invoke: (() =>
                Effect.fail(
                  createMtprotoError('rpc', errorMessage, { code: 403, details: { errorMessage } }),
                )) as MtprotoClient['invoke'],
            }),
          ),
      ),
    ),
  );

  it('loads public poll voters with opaque options and stops repeated pagination cursors', () => {
    const requests: unknown[] = [];
    const invoke = (request: unknown) => {
      requests.push(request);
      return Effect.succeed(
        Api.messages.VotesList({
          count: 3,
          nextOffset: 'next',
          chats: [],
          users: [
            Api.User({
              id: 101n,
              accessHash: 1n,
              firstName: 'Alice',
              photo: Api.UserProfilePhoto({ photoId: 7n, dcId: 2 }),
            }),
          ],
          votes: [
            Api.MessagePeerVote({
              peer: Api.PeerUser({ userId: 101n }),
              option: new Uint8Array([0, 128]),
              date: 123,
            }),
            Api.MessagePeerVoteMultiple({
              peer: Api.PeerUser({ userId: 101n }),
              options: [new Uint8Array([0, 128]), new Uint8Array([255])],
              date: 124,
            }),
            Api.MessagePeerVoteInputOption({ peer: Api.PeerUser({ userId: 101n }), date: 125 }),
          ],
        }),
      );
    };
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const first = yield* transport.getPollVotes!(
              { id: 'g:303', kind: 'group' },
              42,
              '0080',
            );
            expect(first.nextOffset).toBe('next');
            expect(first.people.map((person) => person.options)).toEqual([
              ['0080'],
              ['0080', 'ff'],
              ['0080'],
            ]);
            expect(first.people[0]).toMatchObject({
              name: 'Alice',
              avatarId: '7',
              date: 123,
              peer: { id: 'u:101', accessHash: '1' },
            });
            const last = yield* transport.getPollVotes!(
              { id: 'g:303', kind: 'group' },
              42,
              '0080',
              'next',
            );
            expect(last.nextOffset).toBeUndefined();
            expect(requests[1]).toMatchObject({
              id: 42,
              option: new Uint8Array([0, 128]),
              offset: 'next',
              limit: 50,
            });
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });

  it('sends a quiz using answer indices and maps its server card', () => {
    const draft = {
      question: 'Two plus two?',
      answers: ['Four', 'Five'],
      quiz: true,
      multipleChoice: false,
      publicVoters: true,
      correctAnswer: 0,
      solution: '2 + 2 = 4',
    };
    const invoke = vi.fn((request: unknown) => {
      if (!Api.messages.SendMedia.is(request) || !Api.InputMediaPoll.is(request.media))
        throw new Error('Unexpected request');
      expect(request.media).toMatchObject({
        correctAnswers: [0],
        solution: draft.solution,
        poll: { quiz: true, publicVoters: true },
      });
      expect(request.media.poll.answers[0]).toMatchObject({ option: new Uint8Array([0]) });
      return Effect.succeed(
        Api.Updates({
          date: 123,
          seq: 1,
          users: [],
          chats: [],
          updates: [
            Api.UpdateNewMessage({
              pts: 1,
              ptsCount: 1,
              message: Api.Message({
                id: 81,
                date: 123,
                peerId: Api.PeerUser({ userId: 101n }),
                out: true,
                message: '',
                media: Api.MessageMediaPoll({
                  poll: { ...request.media.poll, id: 42n },
                  results: Api.PollResults({ totalVoters: 0 }),
                }),
              }),
            }),
          ],
        }),
      );
    });
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const sent = yield* transport.sendPoll!(
              { id: 'u:101', kind: 'user', accessHash: '10' },
              draft,
              '123',
            );
            expect(sent.message.poll).toMatchObject({
              id: '42',
              question: draft.question,
              quiz: true,
              publicVoters: true,
              answers: [
                { option: '00', text: 'Four' },
                { option: '01', text: 'Five' },
              ],
              results: { totalVoters: 0 },
            });
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });

  it('sends opaque poll options and maps minimal live results without requiring a peer', () => {
    const invoke = vi.fn((request: unknown) => {
      expect(Api.messages.SendVote.is(request)).toBe(true);
      expect(request).toMatchObject({ msgId: 81, options: [new Uint8Array([0, 255])] });
      return Effect.succeed(
        Api.Updates({
          date: 123,
          seq: 1,
          users: [],
          chats: [],
          updates: [
            Api.UpdateMessagePoll({
              pollId: 42n,
              results: Api.PollResults({
                min: true,
                totalVoters: 4,
                results: [
                  Api.PollAnswerVoters({
                    option: new Uint8Array([0, 255]),
                    voters: 3,
                    recentVoters: [],
                  }),
                ],
              }),
            }),
          ],
        }),
      );
    });
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const result = yield* transport.updatePoll!(
              { id: 'u:101', kind: 'user', accessHash: '10' },
              81,
              {
                id: '42',
                hash: '0',
                question: 'Q',
                answers: [{ option: '00ff', text: 'A' }],
                quiz: false,
                multipleChoice: false,
                publicVoters: false,
                closed: false,
                revotingDisabled: false,
                hideResultsUntilClose: false,
                results: {},
              },
              'vote',
              ['00ff'],
            );
            expect(result.updateBatches?.[0]?.updates[0]).toMatchObject({
              type: 'poll-changed',
              pollId: '42',
              results: { min: true, totalVoters: 4, answers: [{ option: '00ff', voters: 3 }] },
            });
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });

  it('sends contact media and preserves its card in short send acknowledgements', () => {
    const contact = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      phoneNumber: '+123456789',
      vcard: '',
    };
    const invoke = vi.fn((request: unknown) => {
      expect(Api.messages.SendMedia.is(request)).toBe(true);
      expect(request).toMatchObject({ message: '', randomId: 123n, media: contact });
      if (Api.messages.SendMedia.is(request))
        expect(Api.InputMediaContact.is(request.media)).toBe(true);
      return Effect.succeed(
        Api.UpdateShortSentMessage({ id: 81, pts: 1, ptsCount: 1, date: 123, out: true }),
      );
    });
    return Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            const sent = yield* transport.sendContact!(
              { id: 'u:101', kind: 'user', accessHash: '10' },
              contact,
              '123',
            );
            expect(sent.message).toMatchObject({ id: 81, text: '', contact });
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
  });

  it.each([true, false])(
    'writes manual unread mark %s without inventing message receipts',
    (unread) =>
      Effect.runPromise(
        withTransport(
          (transport) =>
            Effect.gen(function* () {
              yield* transport.connect({ apiId: 1, apiHash: 'hash' });
              yield* transport.setUnreadMark(
                { id: 'u:101', kind: 'user', accessHash: '10' },
                unread,
              );
            }),
          () =>
            Effect.succeed(
              clientDouble({
                invoke: ((request: unknown) => {
                  expect(Api.messages.MarkDialogUnread.is(request)).toBe(true);
                  if (Api.messages.MarkDialogUnread.is(request)) {
                    expect(Boolean(request.unread)).toBe(unread);
                    expect(request.peer).toMatchObject({ peer: { userId: 101n, accessHash: 10n } });
                  }
                  return Effect.succeed(true);
                }) as MtprotoClient['invoke'],
              }),
            ),
        ),
      ),
  );

  it.each(['mention', 'reaction'] as const)(
    'marks all %s notifications using the bulk RPC until offset is drained',
    (kind) => {
      let calls = 0;
      return Effect.runPromise(
        withTransport(
          (transport) =>
            Effect.gen(function* () {
              yield* transport.connect({ apiId: 1, apiHash: 'hash' });
              const result = yield* transport.readAllNotifications!(
                { id: 'u:101', kind: 'user', accessHash: '10' },
                kind,
              );
              expect(calls).toBe(2);
              expect(result.updateBatches).toEqual(
                [11, 12].map((pts) => ({ updates: [{ type: 'pts-advanced', pts, ptsCount: 1 }] })),
              );
            }),
          () =>
            Effect.succeed(
              clientDouble({
                invoke: ((request: unknown) => {
                  expect(
                    kind === 'mention'
                      ? Api.messages.ReadMentions.is(request)
                      : Api.messages.ReadReactions.is(request),
                  ).toBe(true);
                  calls += 1;
                  return Effect.succeed(
                    createTl('messages.affectedHistory', {
                      pts: 10 + calls,
                      ptsCount: 1,
                      offset: calls === 1 ? 100 : 0,
                    }),
                  );
                }) as MtprotoClient['invoke'],
              }),
            ),
        ),
      );
    },
  );

  it.each(['mention', 'reaction'] as const)(
    'loads unread %s events and retains their server unread flags',
    (kind) =>
      Effect.runPromise(
        withTransport(
          (transport) =>
            Effect.gen(function* () {
              yield* transport.connect({ apiId: 1, apiHash: 'hash' });
              const page = yield* transport.getUnreadNotifications!(
                { id: 'u:101', kind: 'user', accessHash: '10' },
                kind,
              );
              expect(page.count).toBe(1);
              expect(page.messages[0]).toMatchObject({
                id: 42,
                unreadMention: true,
                unreadReaction: true,
              });
            }),
          () =>
            Effect.succeed(
              clientDouble({
                invoke: ((request: unknown) => {
                  expect(
                    kind === 'mention'
                      ? Api.messages.GetUnreadMentions.is(request)
                      : Api.messages.GetUnreadReactions.is(request),
                  ).toBe(true);
                  return Effect.succeed(
                    Api.messages.Messages({
                      messages: [
                        Api.Message({
                          id: 42,
                          peerId: Api.PeerUser({ userId: 101n }),
                          date: 1,
                          message: 'Reply',
                          mentioned: true,
                          mediaUnread: true,
                          reactions: Api.MessageReactions({
                            results: [],
                            recentReactions: [
                              Api.MessagePeerReaction({
                                unread: true,
                                peerId: Api.PeerUser({ userId: 101n }),
                                date: 2,
                                reaction: Api.ReactionEmoji({ emoticon: '👍' }),
                              }),
                            ],
                          }),
                        }),
                      ],
                      chats: [],
                      users: [],
                      topics: [],
                    }),
                  );
                }) as MtprotoClient['invoke'],
              }),
            ),
        ),
      ),
  );

  it.each([false, true])(
    'correlates all forwarded album results (missing member: %s)',
    async (missing) => {
      const result = Api.Updates({
        date: 1,
        seq: 1,
        users: [],
        chats: [],
        updates: [
          Api.UpdateMessageID({ id: 102, randomId: 124n }),
          Api.UpdateMessageID({ id: 101, randomId: 123n }),
          ...[102, 101]
            .filter((id) => !missing || id !== 102)
            .map((id) =>
              Api.UpdateNewMessage({
                pts: id,
                ptsCount: 1,
                message: Api.Message({
                  id,
                  out: true,
                  peerId: Api.PeerUser({ userId: 2n }),
                  date: 1,
                  message: id === 102 ? 'Caption' : '',
                  groupedId: 99n,
                }),
              }),
            ),
        ],
      });
      const invoke = vi.fn((request: unknown) =>
        Api.messages.ForwardMessages.is(request)
          ? Effect.succeed(result)
          : Effect.succeed(
              Api.messages.Messages({ messages: [], users: [], chats: [], topics: [] }),
            ),
      );
      await Effect.runPromise(
        withTransport(
          (transport) =>
            Effect.gen(function* () {
              yield* transport.connect({ apiId: 1, apiHash: 'hash' });
              const sent = yield* transport
                .forwardMessages(
                  { id: 'u:1', kind: 'user', accessHash: '10' },
                  { id: 'u:2', kind: 'user', accessHash: '20' },
                  [
                    { messageId: 41, randomId: '123' },
                    { messageId: 42, randomId: '124' },
                  ],
                )
                .pipe(Effect.result);
              if (missing) {
                expect(sent._tag).toBe('Failure');
              } else {
                expect(sent._tag).toBe('Success');
                if (sent._tag === 'Success')
                  expect(sent.success.messages).toMatchObject([
                    { id: 101, randomId: '123', groupedId: '99' },
                    { id: 102, randomId: '124', groupedId: '99', text: 'Caption' },
                  ]);
              }
            }),
          () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
        ),
      );
    },
  );

  it('forwards album members in one RPC with one random ID per member', async () => {
    const invoke = vi.fn((_request: unknown) =>
      Effect.fail(createMtprotoError('transport', 'Test stops at RPC')),
    );
    await Effect.runPromise(
      withTransport(
        (transport) =>
          Effect.gen(function* () {
            yield* transport.connect({ apiId: 1, apiHash: 'hash' });
            yield* transport
              .forwardMessages(
                { id: 'u:1', kind: 'user', accessHash: '10' },
                { id: 'u:2', kind: 'user', accessHash: '20' },
                [
                  { messageId: 41, randomId: '123' },
                  { messageId: 42, randomId: '124' },
                ],
                { hideCaption: true, topMessageId: 7 },
              )
              .pipe(Effect.result);
          }),
        () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
      ),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      id: [41, 42],
      randomId: [123n, 124n],
      dropAuthor: true,
      dropMediaCaptions: true,
      topMsgId: 7,
    });
  });

  it.each([
    [undefined, undefined, undefined],
    [{ hideAuthor: true }, true, undefined],
    [{ hideCaption: true }, true, true],
  ] as const)(
    'forwards with Telegram-compatible privacy flags: %j',
    async (options, author, caption) => {
      const invoke = vi.fn((_request: unknown) =>
        Effect.fail(createMtprotoError('transport', 'Test stops at RPC')),
      );
      await Effect.runPromise(
        withTransport(
          (transport) =>
            Effect.gen(function* () {
              yield* transport.connect({ apiId: 1, apiHash: 'hash' });
              yield* transport
                .forwardMessage(
                  { id: 'u:1', kind: 'user', accessHash: '10' },
                  { id: 'u:2', kind: 'user', accessHash: '20' },
                  42,
                  '123',
                  options,
                )
                .pipe(Effect.result);
            }),
          () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
        ),
      );
      const request = invoke.mock.calls[0]?.[0];
      expect(request).toMatchObject({ id: [42], randomId: [123n] });
      expect(Api.messages.ForwardMessages.is(request)).toBe(true);
      if (Api.messages.ForwardMessages.is(request)) {
        expect(request.dropAuthor).toBe(author);
        expect(request.dropMediaCaptions).toBe(caption);
      }
    },
  );

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

  it.each(['inbox', 'outbox'] as const)(
    'invalidates topic metadata for discussion %s receipts',
    (direction) => {
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
              const args = { channelId: 202n, topMsgId: 10, readMaxId: 110 };
              yield* PubSub.publish(
                events,
                updateEvent(
                  direction === 'inbox'
                    ? Api.UpdateReadChannelDiscussionInbox(args)
                    : Api.UpdateReadChannelDiscussionOutbox(args),
                ),
              );
              const batch = yield* Fiber.join(received);
              expect(batch).toMatchObject({
                _tag: 'Some',
                value: {
                  updates: [{ type: 'forum-topics-invalidated', peerId: 'c:202', read: true }],
                },
              });
            }),
          ),
        ),
      );
    },
  );

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

it.each([
  [6000, 100],
  [100, 6000],
  [800, 600],
])('sends a %s × %s image with the appropriate Telegram media type', async (width, height) => {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width, height, close }));
  const file = new File(['original image'], 'screenshot.jpg', { type: 'image/jpeg' });
  const uploaded = Api.InputFile({ id: 1n, parts: 1, name: file.name, md5Checksum: '' });
  const uploadFile = vi.fn(() => Effect.succeed(uploaded));
  const invoke = vi.fn((request: unknown) => {
    if (!Api.messages.SendMedia.is(request))
      return Effect.fail(createMtprotoError('protocol', 'Unexpected RPC'));
    expect(request.message).toBe('Caption');
    expect(request.randomId).toBe(123n);
    expect(request.media).toEqual(
      width === 800
        ? Api.InputMediaUploadedPhoto({ file: uploaded })
        : Api.InputMediaUploadedDocument({
            file: uploaded,
            mimeType: file.type,
            attributes: [Api.DocumentAttributeFilename({ fileName: file.name })],
            forceFile: true,
          }),
    );
    return Effect.succeed(
      Api.UpdateShortSentMessage({ id: 42, pts: 1, ptsCount: 1, date: 1, out: true }),
    );
  });
  try {
    await Effect.runPromise(
      withTransport(
        (target) =>
          Effect.gen(function* () {
            yield* target.connect({ apiId: 1, apiHash: 'hash' });
            return yield* target.sendFile({ id: 'g:303', kind: 'group' }, file, {
              caption: 'Caption',
              randomId: '123',
              sendAs: 'media',
              asSticker: false,
            });
          }),
        () =>
          Effect.succeed(
            clientDouble({ uploadFile, invoke: invoke as unknown as MtprotoClient['invoke'] }),
          ),
      ),
    );
    expect(uploadFile).toHaveBeenCalledExactlyOnceWith({ file, workers: 2 });
    expect(invoke).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps a saved source on short live updates addressed to self', () =>
  Effect.runPromise(
    Effect.scoped(
      providePlatform(
        Effect.gen(function* () {
          const events = yield* PubSub.sliding<MtprotoClientEvent>(8);
          const client = clientDouble({
            events: Stream.fromPubSub(events),
            getMe: Effect.succeed(Api.User({ id: 991n, self: true, firstName: 'Self' })),
          });
          const target = yield* createWebTelegramTransport(makeMemoryCacheStore(), {
            createClient: () => Effect.succeed(client),
          });
          yield* target.connect({ apiId: 1, apiHash: 'hash' });
          yield* target.getAuthorizedAccountId!();
          const received = yield* target.updates.pipe(
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* PubSub.publish(
            events,
            updateEvent(
              Api.UpdateShortMessage({
                id: 80,
                userId: 991n,
                out: true,
                message: 'Saved source',
                pts: 1,
                ptsCount: 1,
                date: 10,
                fwdFrom: createTl('messageFwdHeader', {
                  date: 9,
                  savedFromPeer: Api.PeerChannel({ channelId: 202n }),
                  savedFromMsgId: 7,
                }),
              }),
            ),
          );
          const batch = yield* Fiber.join(received);
          expect(batch).toMatchObject({
            _tag: 'Some',
            value: {
              updates: [
                {
                  type: 'new-message',
                  message: { peerId: 'u:991', senderId: 'u:991', savedPeerId: 'c:202' },
                },
              ],
            },
          });
        }),
      ),
    ),
  ));

it('searches migrated groups through the old peer while retaining filters and original message IDs', () => {
  const requests: unknown[] = [];
  const old = createTl('chat', {
    id: 303n,
    title: 'Team',
    photo: Api.ChatPhotoEmpty({}),
    participantsCount: 1,
    date: 1,
    version: 1,
  });
  const channel = createTl('channel', {
    id: 202n,
    accessHash: 5n,
    title: 'Team',
    photo: Api.ChatPhotoEmpty({}),
    megagroup: true as const,
    date: 1,
  });
  const invoke = (request: unknown) => {
    requests.push(request);
    if (Api.channels.GetFullChannel.is(request))
      return Effect.succeed(
        createTl('messages.chatFull', {
          fullChat: createTl('channelFull', {
            id: 202n,
            about: '',
            migratedFromChatId: 303n,
            migratedFromMaxId: 80,
          }),
          chats: [old, channel],
          users: [],
        }),
      );
    if (Api.messages.Search.is(request))
      return Effect.succeed(
        Api.messages.Messages({
          topics: [],
          users: [],
          chats: [old, channel],
          messages: Api.InputPeerChat.is(request.peer)
            ? [
                Api.Message({
                  id: 70,
                  peerId: Api.PeerChat({ chatId: 303n }),
                  date: 1,
                  message: 'Earlier photo',
                }),
              ]
            : [],
        }),
      );
    if (Api.messages.GetSearchCounters.is(request))
      return Effect.succeed(
        request.filters.map((filter) =>
          createTl('messages.searchCounter', {
            filter,
            count: Api.InputPeerChat.is(request.peer) ? 2 : 3,
          }),
        ),
      );
    return Effect.fail(createMtprotoError('protocol', 'Unexpected migration test RPC'));
  };
  return Effect.runPromise(
    withTransport(
      (transport) =>
        Effect.gen(function* () {
          yield* transport.connect({ apiId: 1, apiHash: 'hash' });
          const peer = { id: 'c:202', kind: 'channel' as const, accessHash: '5' };
          const page = yield* transport.searchMessages('Earlier', peer, 50, undefined, {
            topicId: 1,
            kind: 'photos',
            minDate: 1,
          });
          expect(page.messages[0]).toMatchObject({ id: 70, peerId: 'g:303' });
          const searches = requests.filter((request) => Api.messages.Search.is(request));
          expect(searches).toHaveLength(2);
          expect(searches[0]).toMatchObject({ peer: { channelId: 202n }, topMsgId: 1 });
          expect(searches[1]).toMatchObject({
            peer: { chatId: 303n },
            q: 'Earlier',
            minDate: 1,
            filter: { _: 'inputMessagesFilterPhotos' },
          });
          expect(searches[1]).not.toHaveProperty('topMsgId');
          const counts = yield* transport.getSharedMediaCounts(peer);
          expect(counts.photos).toBe(5);
          expect(
            requests.filter((request) => Api.channels.GetFullChannel.is(request)),
          ).toHaveLength(1);
        }),
      () => Effect.succeed(clientDouble({ invoke: invoke as MtprotoClient['invoke'] })),
    ),
  );
});

it('uploads files as documents and sends them in one server media group', async () => {
  const documents = [1n, 2n].map((id) =>
    Api.Document({
      id,
      accessHash: id,
      fileReference: new Uint8Array(),
      date: 1,
      mimeType: 'image/png',
      size: 100n,
      dcId: 1,
      attributes: [Api.DocumentAttributeFilename({ fileName: `image-${id}.png` })],
    }),
  );
  let uploadIndex = 0;
  const invoke = vi.fn((request: unknown) => {
    if (Api.messages.UploadMedia.is(request)) {
      expect(Api.InputMediaUploadedDocument.is(request.media)).toBe(true);
      if (Api.InputMediaUploadedDocument.is(request.media))
        expect(request.media.forceFile).toBe(true);
      return Effect.succeed(Api.MessageMediaDocument({ document: documents[uploadIndex++]! }));
    }
    if (Api.messages.SendMultiMedia.is(request)) {
      expect(request.multiMedia.map((item) => item.message)).toEqual(['Caption', '']);
      expect(request.multiMedia.map((item) => item.randomId)).toEqual([101n, 102n]);
      expect(request.multiMedia.every((item) => Api.InputMediaDocument.is(item.media))).toBe(true);
      return Effect.succeed(
        Api.Updates({
          users: [],
          chats: [],
          date: 1,
          seq: 1,
          updates: documents.map((document, index) =>
            Api.UpdateNewMessage({
              pts: index + 1,
              ptsCount: 1,
              message: Api.Message({
                id: index + 42,
                peerId: Api.PeerChat({ chatId: 303n }),
                out: true,
                date: 1,
                message: index === 0 ? 'Caption' : '',
                groupedId: 99n,
                media: Api.MessageMediaDocument({ document }),
              }),
            }),
          ),
        }),
      );
    }
    return Effect.fail(createMtprotoError('protocol', 'Unexpected RPC'));
  });
  await Effect.runPromise(
    withTransport(
      (target) =>
        Effect.gen(function* () {
          yield* target.connect({ apiId: 1, apiHash: 'hash' });
          const result = yield* target.sendAlbum(
            { id: 'g:303', kind: 'group' },
            [101, 102].map((id) => ({
              file: new File(['original'], `image-${id}.png`, { type: 'image/png' }),
              randomId: String(id),
              sendAs: 'file' as const,
            })),
            { caption: 'Caption' },
          );
          expect(result.messages).toHaveLength(2);
          expect(
            result.messages.every(
              (message) => message.groupedId === '99' && message.media?.kind === 'file',
            ),
          ).toBe(true);
        }),
      () =>
        Effect.succeed(
          clientDouble({
            uploadFile: ({ file }) =>
              Effect.succeed(
                Api.InputFile({ id: 1n, parts: 1, name: file.name ?? 'upload', md5Checksum: '' }),
              ),
            invoke: invoke as unknown as MtprotoClient['invoke'],
          }),
        ),
    ),
  );
  expect(uploadIndex).toBe(2);
  expect(
    invoke.mock.calls.filter(([request]) => Api.messages.SendMultiMedia.is(request)),
  ).toHaveLength(1);
});
