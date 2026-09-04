import { BrowserCrypto } from '@effect/platform-browser';
import { Deferred, Effect, Fiber, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMtprotoError } from '../mtproto/errors';
import { makeMemoryCacheStore } from '../persistence/memoryStore';
import { createFixtureTelegramTransport } from '../transports/fixtureTransport';
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

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' } });
  // The coordinator owns the lease. Engine startup and reconnect must work
  // without touching the Web Locks API when manageTabLease is false.
  vi.stubGlobal('navigator', {});
});
afterEach(() => vi.unstubAllGlobals());

describe('MessagingEngine lifecycle regressions', () => {
  it('joins overlapping starts and retry without invalidating readiness', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let connects = 0;
        const transport = {
          ...original,
          connect: () =>
            Effect.gen(function* () {
              connects += 1;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* original.connect(credentials);
            }),
        };
        const engine = yield* makeMessagingEngine(transport, makeMemoryCacheStore(), {
          manageTabLease: false,
        });
        const first = yield* engine.start(credentials).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const second = yield* engine.start(credentials).pipe(Effect.forkChild);
        const retry = yield* engine.retrySync().pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Effect.all([Fiber.join(first), Fiber.join(second), Fiber.join(retry)]);
        yield* engine.whenAccountReady();
        expect(connects).toBe(1);
        expect(engine.snapshot()).toMatchObject({ phase: 'ready', online: true });
      }),
    ));

  it('keeps one session-owned update consumer across reconnects and releases it on stop', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        let active = 0;
        let subscriptions = 0;
        const updates = Stream.unwrap(
          Effect.sync(() => {
            active += 1;
            subscriptions += 1;
            return original.updates.pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  active -= 1;
                }),
              ),
            );
          }),
        );
        const engine = yield* makeMessagingEngine(
          { ...original, updates },
          makeMemoryCacheStore(),
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          window.__televechaFixture?.emit({ type: 'connection-state', connected: false });
          yield* Effect.yieldNow;
          expect(engine.snapshot().online).toBe(false);
          yield* engine.retrySync();
          expect(engine.snapshot().online).toBe(true);
          expect(active).toBe(1);
        }
        expect(subscriptions).toBe(1);
        const invalidations: string[] = [];
        const unsubscribe = yield* engine.subscribeResources((event) =>
          invalidations.push(event.kind),
        );
        window.__televechaFixture?.emit({ type: 'expression-index-changed', kind: 'all' });
        yield* Effect.yieldNow;
        expect(invalidations).toEqual(['expressions']);
        yield* unsubscribe;
        yield* engine.stop();
        expect(active).toBe(0);
        yield* engine.start(credentials);
        expect(active).toBe(1);
        expect(subscriptions).toBe(2);
      }),
    ));

  it('stops an in-flight startup and makes a later start wait for cleanup', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const connecting = yield* Deferred.make<void>();
        const disconnecting = yield* Deferred.make<void>();
        const releaseDisconnect = yield* Deferred.make<void>();
        let connects = 0;
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            connect: () =>
              Effect.gen(function* () {
                connects += 1;
                if (connects === 1) {
                  yield* Deferred.succeed(connecting, undefined);
                  return yield* Effect.never;
                }
                yield* original.connect(credentials);
              }),
            disconnect: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(disconnecting, undefined);
                yield* Deferred.await(releaseDisconnect);
                yield* original.disconnect();
              }),
          },
          makeMemoryCacheStore(),
          { manageTabLease: false },
        );
        const first = yield* engine.start(credentials).pipe(Effect.forkChild);
        yield* Deferred.await(connecting);
        const stopped = yield* engine.stop().pipe(Effect.forkChild);
        yield* Deferred.await(disconnecting);
        const restarted = yield* engine.start(credentials).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(connects).toBe(1);
        yield* Deferred.succeed(releaseDisconnect, undefined);
        yield* Fiber.join(stopped);
        expect((yield* Fiber.await(first))._tag).toBe('Failure');
        yield* Fiber.join(restarted);
        expect(connects).toBe(2);
        expect(engine.snapshot()).toMatchObject({ phase: 'ready', online: true });
      }),
    ));

  it.each(['invalid JSON', '{}'])('refetches invalid legacy metadata: %s', (text) =>
    run(
      Effect.gen(function* () {
        const transport = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const engine = yield* makeMessagingEngine(transport, store, { manageTabLease: false });
        yield* engine.start(credentials);
        yield* store.saveBlob('sticker-index:recent:v2', new Blob([text]));
        yield* store.saveBlob('sticker-index:packs:v2', new Blob([text]));
        const recent = yield* engine.getRecentStickers();
        const packs = yield* engine.getStickerPacks();
        expect(recent.length).toBeGreaterThan(0);
        expect(packs.length).toBeGreaterThan(0);
        expect(yield* engine.getRecentStickers()).toEqual(recent);
        expect(window.__televechaFixture?.stats.getRecentStickers).toBe(1);
        expect(window.__televechaFixture?.stats.getStickerPacks).toBe(1);
      }),
    ),
  );
  it('keeps a persisted random id when a failed send is retried after restart', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const randomIds: string[] = [];
        let shouldFail = true;
        const transport = {
          ...original,
          sendText: (...args: Parameters<typeof original.sendText>) =>
            Effect.gen(function* () {
              randomIds.push(args[2]);
              if (shouldFail)
                return yield* Effect.fail(createMtprotoError('rpc', 'send unavailable'));
              return yield* original.sendText(...args);
            }),
        };
        const engine = yield* makeMessagingEngine(transport, store, { manageTabLease: false });
        yield* engine.start(credentials);
        const peer = { id: 'u:101', kind: 'user' as const };
        yield* engine.setDraft(peer.id, 'Keep this send');
        yield* engine.sendDraft(peer, 'Keep this send');
        const pending = (yield* store.loadWorkspace()).pending;
        expect(pending).toHaveLength(1);
        expect(pending[0]?.randomId).toBe(randomIds[0]);
        yield* engine.stop();
        shouldFail = false;
        yield* engine.start(credentials);
        yield* engine.retryPendingSend(pending[0]!.id);
        expect(randomIds.length).toBeGreaterThanOrEqual(2);
        expect(new Set(randomIds).size).toBe(1);
        expect((yield* store.loadWorkspace()).pending).toEqual([]);
      }),
    ));

  it('does not roll a newer server reaction back when an optimistic request fails', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            setReaction: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return yield* Effect.fail(createMtprotoError('rpc', 'reaction rejected'));
              }),
          },
          makeMemoryCacheStore(),
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        const peer = { id: 'u:101', kind: 'user' as const };
        const view = yield* engine.loadConversationView(peer.id);
        const message = view.messages[0]!;
        const request = yield* engine.toggleReaction(peer, message.id, '👍').pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const reactions = [{ emoji: '❤️', count: 4, chosen: false }];
        window.__televechaFixture?.emit({
          type: 'reaction-changed',
          peerId: peer.id,
          messageId: message.id,
          reactions,
        });
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(request);
        const updated = yield* engine.loadConversationView(peer.id);
        expect(updated.messages.find(({ id }) => id === message.id)?.reactions).toEqual(reactions);
      }),
    ));
  it('discards metadata that completes after the account changes', () =>
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
            getRecentStickers: () =>
              Effect.gen(function* () {
                const stickers = yield* original.getRecentStickers();
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return stickers;
              }),
          },
          store,
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        const oldRequest = yield* engine.getRecentStickers().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        window.__televechaFixture?.emit({ type: 'connection-state', connected: false });
        yield* Effect.yieldNow;
        accountId = '900000002';
        yield* engine.retrySync();
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(oldRequest)).toEqual([]);
        expect(yield* store.loadMetadata('sticker-index:recent:v2')).toBeUndefined();
        expect(yield* store.loadAccountId()).toBe(accountId);
      }),
    ));
  it('reacquires a standalone lease when restarting a failed session', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        let acquisitions = 0;
        vi.stubGlobal('navigator', {
          locks: {
            request: (
              _name: string,
              _options: unknown,
              callback: (lock: object) => Promise<void>,
            ) => {
              acquisitions += 1;
              return callback({});
            },
          },
        });
        let failConnect = true;
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            connect: () =>
              failConnect
                ? Effect.fail(createMtprotoError('transport', 'connection failed'))
                : original.connect(credentials),
          },
          makeMemoryCacheStore(),
        );
        yield* engine.start(credentials);
        expect(engine.snapshot().phase).toBe('error');
        failConnect = false;
        yield* engine.start(credentials);
        expect(engine.snapshot().online).toBe(true);
        expect(acquisitions).toBe(2);
        yield* engine.stop();
      }),
    ));

  it('waits for an accepted draft write before clearing account data on logout', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const engine = yield* makeMessagingEngine(
          original,
          {
            ...store,
            saveDraft: (...args: Parameters<typeof store.saveDraft>) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                yield* store.saveDraft(...args);
              }).pipe(Effect.uninterruptible),
          },
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        const writing = yield* engine.setDraft('u:101', 'Old account draft').pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const logout = yield* engine.logOut().pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(logout.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(writing);
        yield* Fiber.join(logout);
        expect((yield* store.loadWorkspace()).drafts).toEqual({});
        expect(engine.snapshot().phase).toBe('unauthorized');
      }),
    ));
});
