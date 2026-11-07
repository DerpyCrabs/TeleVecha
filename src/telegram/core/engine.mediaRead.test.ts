import { BrowserCrypto } from '@effect/platform-browser';
import { Deferred, Effect, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMtprotoError } from '../mtproto/errors';
import { makeMemoryCacheStore } from '../persistence/memoryStore';
import { createFixtureTelegramTransport } from '../transports/fixtureTransport';
import type { TelegramMessage, TelegramPeer, TransportUpdate } from '../types';
import { makeMessagingEngine, MessagingEngineLayer } from './engine';

const credentials = { apiId: 1, apiHash: 'fixture' };
const run = <A, E>(
  effect: Effect.Effect<A, E, Effect.Services<ReturnType<typeof makeMessagingEngine>>>,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(MessagingEngineLayer),
      Effect.provide(BrowserCrypto.layer),
    ),
  );
const voice = (peerId = 'u:101', overrides: Partial<TelegramMessage> = {}): TelegramMessage => ({
  id: 81,
  peerId,
  senderId: 'u:101',
  text: '',
  date: 1_700_000_081,
  outgoing: false,
  mediaUnread: true,
  media: { kind: 'voice', name: 'voice.ogg', mimeType: 'audio/ogg' },
  ...overrides,
});
beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' } });
  vi.stubGlobal('navigator', {});
});
afterEach(() => vi.unstubAllGlobals());

describe('voice and video message content receipts', () => {
  it.each(['mention', 'reaction'] as const)(
    'acknowledges only viewed %s notifications and retries failures',
    (kind) =>
      run(
        Effect.gen(function* () {
          const original = yield* createFixtureTelegramTransport();
          const store = makeMemoryCacheStore();
          const peer: TelegramPeer = { id: 'u:101', kind: 'user' };
          const source = voice(peer.id, {
            media: undefined,
            mediaUnread: kind === 'mention',
            outgoing: kind === 'reaction',
            unreadMention: kind === 'mention',
            unreadReaction: kind === 'reaction',
          });
          let fail = true;
          const readMessageContents = vi.fn(() =>
            fail
              ? Effect.fail(createMtprotoError('transport', 'Receipt failed'))
              : Effect.succeed({}),
          );
          const engine = yield* makeMessagingEngine(
            {
              ...original,
              readMessageContents,
              getHistory: () =>
                Effect.succeed({ messages: [source, { ...source, id: 82 }], hasOlder: false }),
            },
            store,
            { manageTabLease: false },
          );
          yield* engine.start(credentials);
          yield* engine.loadConversationView(peer.id);
          expect(readMessageContents).not.toHaveBeenCalled();
          expect(
            (yield* engine.markMessageNotificationsRead(peer, [81]).pipe(Effect.result))._tag,
          ).toBe('Failure');
          expect(
            (yield* store.loadMessage(peer.id, 81))?.[
              kind === 'mention' ? 'unreadMention' : 'unreadReaction'
            ],
          ).toBe(true);
          fail = false;
          yield* engine.markMessageNotificationsRead(peer, [81, 81, -1, 999]);
          yield* engine.markMessageNotificationsRead(peer, [81]);
          expect(readMessageContents.mock.calls).toHaveLength(2);
          expect(readMessageContents).toHaveBeenLastCalledWith(peer, [81]);
          expect(yield* store.loadMessage(peer.id, 81)).toMatchObject({
            unreadMention: false,
            unreadReaction: false,
          });
          expect(
            (yield* store.loadMessage(peer.id, 82))?.[
              kind === 'mention' ? 'unreadMention' : 'unreadReaction'
            ],
          ).toBe(true);
        }),
      ),
  );

  it.each<TelegramPeer>([
    { id: 'u:101', kind: 'user' },
    { id: 'g:303', kind: 'group' },
    { id: 'c:202', kind: 'channel', accessHash: '2' },
  ])('acknowledges each incoming message once in $kind chats', (peer) =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const source = voice(peer.id);
        const readMessageContents = vi.fn(original.readMessageContents);
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            readMessageContents,
            getHistory: () => Effect.succeed({ messages: [source], hasOlder: false }),
          },
          store,
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        yield* engine.loadConversationView(peer.id);
        const published: TelegramMessage[] = [];
        const unsubscribe = yield* engine.subscribeConversationEvents((event) => {
          if (event.type === 'message-upsert') published.push(event.message);
        });
        expect(readMessageContents).not.toHaveBeenCalled();
        yield* Effect.all(
          [engine.markMediaRead(peer, source.id), engine.markMediaRead(peer, source.id)],
          { concurrency: 'unbounded' },
        );
        yield* engine.markMediaRead(peer, source.id);
        expect(readMessageContents).toHaveBeenCalledExactlyOnceWith(peer, [source.id]);
        expect((yield* store.loadMessage(peer.id, source.id))?.mediaUnread).toBe(false);
        expect(published.at(-1)?.mediaUnread).toBe(false);
        yield* unsubscribe;
      }),
    ),
  );

  it('ignores outgoing, already listened, missing, and non-voice media', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const peer: TelegramPeer = { id: 'u:101', kind: 'user' };
        const messages = [
          voice(peer.id, { id: 81, outgoing: true }),
          voice(peer.id, { id: 82, mediaUnread: false }),
          voice(peer.id, {
            id: 83,
            media: { kind: 'file', name: 'song.mp3', mimeType: 'audio/mpeg' },
          }),
          voice(peer.id, {
            id: 84,
            media: { kind: 'video', name: 'video.mp4', mimeType: 'video/mp4' },
          }),
          voice(peer.id, {
            id: 85,
            media: { kind: 'round-video', name: 'round.mp4', mimeType: 'video/mp4' },
          }),
          voice(peer.id, { id: 86, mediaUnread: undefined }),
        ];
        const readMessageContents = vi.fn(original.readMessageContents);
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            readMessageContents,
            getHistory: () => Effect.succeed({ messages, hasOlder: false }),
          },
          store,
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        yield* engine.loadConversationView(peer.id);
        for (const id of [81, 82, 83, 84, -1, NaN, 0, 999]) yield* engine.markMediaRead(peer, id);
        expect(readMessageContents).not.toHaveBeenCalled();
        yield* engine.markMediaRead(peer, 85);
        // Cached messages from earlier versions have no mediaUnread field yet.
        yield* engine.markMediaRead(peer, 86);
        expect(readMessageContents.mock.calls).toEqual([
          [peer, [85]],
          [peer, [86]],
        ]);
      }),
    ));

  it('keeps a failed receipt unread and retries on the next playback', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const peer: TelegramPeer = { id: 'u:101', kind: 'user' };
        let fail = true;
        const readMessageContents = vi.fn(() =>
          fail
            ? Effect.fail(createMtprotoError('transport', 'Receipt failed'))
            : Effect.succeed({}),
        );
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            readMessageContents,
            getHistory: () => Effect.succeed({ messages: [voice()], hasOlder: false }),
          },
          store,
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        yield* engine.loadConversationView(peer.id);
        expect((yield* engine.markMediaRead(peer, 81).pipe(Effect.result))._tag).toBe('Failure');
        expect((yield* store.loadMessage(peer.id, 81))?.mediaUnread).toBe(true);
        fail = false;
        yield* engine.markMediaRead(peer, 81);
        expect(readMessageContents).toHaveBeenCalledTimes(2);
        expect((yield* store.loadMessage(peer.id, 81))?.mediaUnread).toBe(false);
      }),
    ));

  it.each([false, true])(
    'syncs remote receipts without mixing channel message ids (channel=%s)',
    (channel) =>
      run(
        Effect.gen(function* () {
          const original = yield* createFixtureTelegramTransport();
          const store = makeMemoryCacheStore();
          const advanced = yield* Deferred.make<void>();
          const engine = yield* makeMessagingEngine(
            original,
            {
              ...store,
              saveCursor: (cursor) =>
                store
                  .saveCursor(cursor)
                  .pipe(
                    Effect.andThen(
                      cursor.pts === 11 ? Deferred.succeed(advanced, undefined) : Effect.void,
                    ),
                  ),
            },
            { manageTabLease: false },
          );
          yield* engine.start(credentials);
          for (const peerId of ['u:101', 'c:202'])
            yield* store.putMessage({ ...voice(peerId, { outgoing: true }), cacheEpoch: 0 });
          const peerId = channel ? 'c:202' : 'u:101';
          const applied = yield* Deferred.make<void>();
          const unsubscribe = yield* engine.subscribeConversationEvents((event) => {
            if (
              event.type === 'message-upsert' &&
              event.message.peerId === peerId &&
              event.message.mediaUnread === false
            )
              Deferred.doneUnsafe(applied, Effect.void);
          });
          const update: TransportUpdate = {
            type: 'read-message-contents',
            messageIds: [81],
            pts: channel ? 0 : 11,
            ptsCount: channel ? 0 : 1,
            ...(channel ? { peerId, channelScoped: true } : {}),
          };
          window.__televechaFixture!.emit(update);
          yield* Deferred.await(applied);
          yield* unsubscribe;
          expect((yield* store.loadMessage(peerId, 81))?.mediaUnread).toBe(false);
          expect((yield* store.loadMessage(channel ? 'u:101' : 'c:202', 81))?.mediaUnread).toBe(
            true,
          );
          if (!channel) yield* Deferred.await(advanced);
          expect((yield* store.loadCursor())?.pts).toBe(channel ? 10 : 11);
          expect(window.__televechaFixture!.stats.getChannelDifference).toBe(0);
        }),
      ),
  );

  it('preserves concurrent message edits while a receipt is in flight', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const peer: TelegramPeer = { id: 'u:101', kind: 'user' };
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            getHistory: () => Effect.succeed({ messages: [voice()], hasOlder: false }),
            readMessageContents: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({}),
              ),
          },
          store,
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        yield* engine.loadConversationView(peer.id);
        const receipt = yield* engine.markMediaRead(peer, 81).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const edited = yield* Deferred.make<void>();
        const unsubscribe = yield* engine.subscribeConversationEvents((event) => {
          if (event.type === 'message-upsert' && event.message.text === 'Edited caption')
            Deferred.doneUnsafe(edited, Effect.void);
        });
        window.__televechaFixture!.emit({
          type: 'edit-message',
          pts: 11,
          ptsCount: 1,
          message: voice(peer.id, { text: 'Edited caption', editedAt: 1_700_000_090 }),
        });
        yield* Deferred.await(edited);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(receipt);
        yield* unsubscribe;
        expect(yield* store.loadMessage(peer.id, 81)).toMatchObject({
          text: 'Edited caption',
          mediaUnread: false,
        });
      }),
    ));

  it('does not erase a newer reaction while an earlier read receipt is in flight', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const peer: TelegramPeer = { id: 'u:101', kind: 'user' };
        const source = voice(peer.id, {
          outgoing: true,
          media: undefined,
          mediaUnread: false,
          unreadReaction: true,
        });
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            getHistory: () => Effect.succeed({ messages: [source], hasOlder: false }),
            readMessageContents: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({}),
              ),
          },
          store,
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        yield* engine.loadConversationView(peer.id);
        const receipt = yield* engine
          .markMessageNotificationsRead(peer, [81])
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const updated = yield* Deferred.make<void>();
        const unsubscribe = yield* engine.subscribeConversationEvents((event) => {
          if (event.type === 'message-upsert' && event.message.reactions?.[0]?.count === 2)
            Deferred.doneUnsafe(updated, Effect.void);
        });
        window.__televechaFixture!.emit({
          type: 'reaction-changed',
          peerId: peer.id,
          messageId: 81,
          unreadReaction: true,
          reactions: [{ emoji: '👍', count: 2, chosen: false }],
        });
        yield* Deferred.await(updated);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(receipt);
        yield* unsubscribe;
        expect((yield* store.loadMessage(peer.id, 81))?.unreadReaction).toBe(true);
        yield* engine.markMessageNotificationsRead(peer, [81]);
        expect((yield* store.loadMessage(peer.id, 81))?.unreadReaction).toBe(false);
      }),
    ));

  it('discards receipts that complete after the Telegram account changes', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let accountId = '900000001';
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            getAuthorizedAccountId: () => Effect.succeed(accountId),
            getHistory: () => Effect.succeed({ messages: [voice()], hasOlder: false }),
            readMessageContents: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({}),
              ),
          },
          store,
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        yield* engine.loadConversationView('u:101');
        const receipt = yield* engine
          .markMediaRead({ id: 'u:101', kind: 'user' }, 81)
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        window.__televechaFixture!.emit({ type: 'connection-state', connected: false });
        yield* Effect.yieldNow;
        accountId = '900000002';
        yield* engine.retrySync();
        yield* store.putMessage({ ...voice(), cacheEpoch: 0 });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(receipt);
        expect((yield* store.loadMessage('u:101', 81))?.mediaUnread).toBe(true);
      }),
    ));
});
