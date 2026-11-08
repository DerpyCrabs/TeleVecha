import { BrowserCrypto } from '@effect/platform-browser';
import { Deferred, Effect, Fiber, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMtprotoError } from '../mtproto/errors';
import { makeMemoryCacheStore } from '../persistence/memoryStore';
import { createFixtureTelegramTransport } from '../transports/fixtureTransport';
import { makeMessagingEngine, MessagingEngineLayer } from './engine';
import { telegramMediaAssetKey } from './mediaAssetKey';

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
  it.each([false, true])(
    'removes a cancelled attachment from memory and storage (active: %s)',
    (active) =>
      run(
        Effect.gen(function* () {
          const original = yield* createFixtureTelegramTransport();
          const started = yield* Deferred.make<void>();
          const stopped = yield* Deferred.make<void>();
          const store = makeMemoryCacheStore();
          const engine = yield* makeMessagingEngine(
            {
              ...original,
              sendFile: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined);
                  if (active) return yield* Effect.never;
                  return yield* Effect.fail(createMtprotoError('protocol', 'Photo rejected'));
                }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
            },
            store,
            { manageTabLease: false },
          );
          yield* engine.start(credentials);
          const sending = yield* engine
            .sendAttachments(
              { id: 'u:101', kind: 'user' },
              [{ file: new File(['photo'], 'photo.png', { type: 'image/png' }), sendAs: 'media' }],
              'cancel this photo',
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Effect.yieldNow;
          if (!active) yield* Fiber.join(sending);
          const pending = engine.snapshot().pending[0]!;
          expect(pending).toBeDefined();
          if (!active) expect(pending.lastError).toBeTruthy();
          expect(yield* engine.cancelPendingSend(pending.id)).toBe(true);
          if (active) expect(yield* Deferred.isDone(stopped)).toBe(true);
          expect(engine.snapshot().pending).toEqual([]);
          expect((yield* store.loadWorkspace()).pending).toEqual([]);
          yield* engine.stop();
        }),
      ),
  );

  it.each([
    { count: 1, mimeType: 'image/png', sendAs: 'media' as const },
    { count: 2, mimeType: 'image/png', sendAs: 'media' as const },
    { count: 1, mimeType: 'image/png', sendAs: 'file' as const },
    { count: 2, mimeType: 'image/png', sendAs: 'file' as const },
    { count: 1, mimeType: 'video/webm', sendAs: 'media' as const },
    { count: 2, mimeType: 'video/webm', sendAs: 'media' as const },
  ])(
    'caches originals and previews before publishing confirmation: %j',
    ({ count, mimeType, sendAs }) =>
      run(
        Effect.gen(function* () {
          const original = yield* createFixtureTelegramTransport();
          const store = makeMemoryCacheStore();
          const cachedKeys = new Set<string>();
          const namePrefix = `upload-${count}-${mimeType.replace('/', '-')}-${sendAs}-`;
          const publishedWithCache: boolean[] = [];
          const downloadMedia = vi.fn(original.downloadMedia);
          const engine = yield* makeMessagingEngine(
            { ...original, downloadMedia },
            {
              ...store,
              saveBlob: (key, blob) =>
                store.saveBlob(key, blob).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      cachedKeys.add(key);
                    }),
                  ),
                ),
            },
            { manageTabLease: false },
          );
          yield* engine.start(credentials);
          const peer = { id: 'u:101', kind: 'user' as const };
          yield* engine.loadConversationView(peer.id);
          const unsubscribe = yield* engine.subscribeConversationEvents((event) => {
            if (
              event.type === 'message-upsert' &&
              event.message.media?.name.startsWith(namePrefix)
            ) {
              const key = telegramMediaAssetKey(event.message);
              publishedWithCache.push(
                cachedKeys.has(key) &&
                  (mimeType.startsWith('image/') || cachedKeys.has(`preview:${key}`)),
              );
            }
          });
          const attachments = Array.from({ length: count }, (_, index) => ({
            file: new File([`original media ${index}`], `${namePrefix}${index}`, {
              type: mimeType,
            }),
            ...(mimeType.startsWith('video/')
              ? { preview: new Blob([`thumbnail ${index}`], { type: 'image/jpeg' }) }
              : {}),
            sendAs,
            width: 600,
            height: 400,
          }));
          yield* engine.sendAttachments(peer, attachments, 'Local upload');
          yield* Effect.yieldNow;
          expect(publishedWithCache).toHaveLength(count);
          expect(publishedWithCache.every(Boolean)).toBe(true);
          expect((yield* store.loadWorkspace()).pending).toEqual([]);
          const uploaded = (yield* engine.loadConversationView(peer.id)).messages.filter(
            (message) => message.media?.name.startsWith(namePrefix),
          );
          expect(uploaded).toHaveLength(count);
          if (count > 1) {
            expect(uploaded[0]!.groupedId).toBeTruthy();
            expect(uploaded.every((message) => message.groupedId === uploaded[0]!.groupedId)).toBe(
              true,
            );
          }
          if (sendAs === 'file')
            expect(uploaded.every((message) => message.media?.kind === 'file')).toBe(true);
          for (const [index, message] of uploaded.entries()) {
            const blob = yield* engine.downloadMedia(message);
            expect(yield* Effect.promise(() => blob.text())).toBe(`original media ${index}`);
            const preview = yield* engine.downloadMedia(message, { preview: true });
            expect(yield* Effect.promise(() => preview.text())).toBe(
              mimeType.startsWith('video/') ? `thumbnail ${index}` : `original media ${index}`,
            );
          }
          expect(downloadMedia).not.toHaveBeenCalled();
          yield* unsubscribe;
          yield* engine.stop();
        }),
      ),
  );

  it.each([false, true])(
    'caches replacement media before its edit update (envelope: %s)',
    (envelope) =>
      run(
        Effect.gen(function* () {
          const original = yield* createFixtureTelegramTransport();
          const store = makeMemoryCacheStore();
          const cachedKeys = new Set<string>();
          const publishedWithCache: boolean[] = [];
          const downloadMedia = vi.fn(original.downloadMedia);
          const engine = yield* makeMessagingEngine(
            {
              ...original,
              downloadMedia,
              editMessage: (...args: Parameters<typeof original.editMessage>) =>
                original
                  .editMessage(...args)
                  .pipe(
                    Effect.map((result) => ({
                      ...result,
                      ...(envelope
                        ? {
                            updateBatches: [
                              {
                                updates: [
                                  {
                                    type: 'edit-message' as const,
                                    message: result.message,
                                    pts: 0,
                                    ptsCount: 0,
                                  },
                                ],
                              },
                            ],
                          }
                        : {}),
                    })),
                  ),
            },
            {
              ...store,
              saveBlob: (key, blob) =>
                store.saveBlob(key, blob).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      cachedKeys.add(key);
                    }),
                  ),
                ),
            },
            { manageTabLease: false },
          );
          yield* engine.start(credentials);
          const peer = { id: 'u:101', kind: 'user' as const };
          const before = (yield* engine.loadConversationView(peer.id)).messages.find(
            ({ id }) => id === 78,
          )!;
          yield* store.saveBlob(telegramMediaAssetKey(before), new Blob(['old image']));
          const unsubscribe = yield* engine.subscribeConversationEvents((event) => {
            if (event.type === 'message-upsert' && event.message.id === 78) {
              publishedWithCache.push(cachedKeys.has(telegramMediaAssetKey(event.message)));
            }
          });
          const replacement = new File(['replacement image'], `replacement-${envelope}.png`, {
            type: 'image/png',
          });
          yield* engine.editMessage(peer, 78, 'Replaced', undefined, {
            file: replacement,
            sendAs: 'media',
          });
          yield* Effect.yieldNow;
          expect(publishedWithCache.length).toBeGreaterThan(0);
          expect(publishedWithCache.every(Boolean)).toBe(true);
          const message = (yield* engine.loadConversationView(peer.id)).messages.find(
            ({ id }) => id === 78,
          )!;
          const full = yield* engine.downloadMedia(message);
          const preview = yield* engine.downloadMedia(message, { preview: true });
          expect(yield* Effect.promise(() => full.text())).toBe('replacement image');
          expect(yield* Effect.promise(() => preview.text())).toBe('replacement image');
          expect(yield* store.loadBlob(telegramMediaAssetKey(before))).toBeUndefined();
          expect(downloadMedia).not.toHaveBeenCalled();
          yield* unsubscribe;
          yield* engine.stop();
        }),
      ),
  );

  it('leaves the original cached image intact when replacing it fails', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const store = makeMemoryCacheStore();
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            editMessage: () => Effect.fail(createMtprotoError('rpc', 'Edit rejected')),
          },
          store,
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        const peer = { id: 'u:101', kind: 'user' as const };
        const before = (yield* engine.loadConversationView(peer.id)).messages.find(
          ({ id }) => id === 78,
        )!;
        const key = telegramMediaAssetKey(before);
        yield* store.saveBlob(key, new Blob(['old image']));
        const result = yield* engine
          .editMessage(peer, 78, 'Replacement', undefined, {
            file: new File(['new image'], 'replacement.png', { type: 'image/png' }),
            sendAs: 'media',
          })
          .pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        const after = (yield* engine.loadConversationView(peer.id)).messages.find(
          ({ id }) => id === 78,
        )!;
        expect(after).toEqual(before);
        const blob = yield* store.loadBlob(key);
        expect(yield* Effect.promise(() => blob!.text())).toBe('old image');
        yield* engine.stop();
      }),
    ));

  it('keeps cached pins and a healthy chat when background pinned loading times out, without retrying on every visit', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        const cachedPin = {
          id: 79,
          peerId: 'u:101',
          senderId: 'u:101',
          text: 'Cached pin',
          date: 1,
          outgoing: false,
        };
        const pinnedStarted = yield* Deferred.make<void>();
        const getPinnedMessages = vi.fn(() =>
          Deferred.succeed(pinnedStarted, undefined).pipe(Effect.andThen(Effect.never)),
        );
        const store = makeMemoryCacheStore();
        const engine = yield* makeMessagingEngine(
          { ...original, getPinnedMessages },
          {
            ...store,
            loadPinnedMessages: () => Effect.succeed({ value: [cachedPin], savedAt: 0 }),
          },
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        yield* engine.loadConversationView('u:101');
        const loading = yield* engine
          .loadConversationPinnedMessages('u:101')
          .pipe(Effect.forkChild);
        yield* Deferred.await(pinnedStarted);
        expect(getPinnedMessages).toHaveBeenCalledOnce();
        expect((yield* engine.loadConversationView('u:101')).messages.length).toBeGreaterThan(0);
        yield* TestClock.adjust('15 seconds');
        expect(yield* Fiber.join(loading)).toEqual([cachedPin]);
        expect(engine.snapshot()).toMatchObject({ phase: 'ready', online: true, sync: 'current' });
        expect(engine.snapshot().operationError).toBeUndefined();
        for (let visit = 0; visit < 3; visit++) {
          expect(yield* engine.loadConversationPinnedMessages('u:101')).toEqual([cachedPin]);
        }
        expect(getPinnedMessages).toHaveBeenCalledOnce();
        yield* engine.stop();
      }).pipe(Effect.provide(TestClock.layer())),
    ));

  it('automatically reconnects after a live sync failure and survives a failed catch-up attempt', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        let failures = 0;
        let connects = 0;
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            connect: () =>
              Effect.gen(function* () {
                connects += 1;
                yield* original.connect(credentials);
              }),
            getDifference: (...args: Parameters<typeof original.getDifference>) =>
              failures-- > 0
                ? Effect.fail(createMtprotoError('transport', 'Temporary sync failure'))
                : original.getDifference(...args),
          },
          makeMemoryCacheStore(),
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        failures = 2;
        window.__televechaFixture?.emit({ type: 'too-long' });
        yield* Effect.yieldNow;
        expect(engine.snapshot()).toMatchObject({ phase: 'ready', online: false });
        yield* engine.sendDraft({ id: 'u:101', kind: 'user' }, 'Queued during sync failure');
        expect(engine.snapshot().pending).toHaveLength(1);
        expect(window.__televechaFixture?.stats.sendText).toBe(0);
        yield* TestClock.adjust('1 second');
        expect(connects).toBe(2);
        expect(engine.snapshot().online).toBe(false);
        yield* TestClock.adjust('2 seconds');
        expect(connects).toBe(3);
        expect(engine.snapshot()).toMatchObject({ phase: 'ready', online: true, sync: 'current' });
        expect(engine.snapshot().pending).toHaveLength(0);
        expect(window.__televechaFixture?.stats.sendText).toBe(1);
        yield* TestClock.adjust('30 seconds');
        expect(connects).toBe(3);
        yield* engine.stop();
      }).pipe(Effect.provide(TestClock.layer())),
    ));

  it('disposes a failed reconnect client before the next automatic attempt', () =>
    run(
      Effect.gen(function* () {
        const original = yield* createFixtureTelegramTransport();
        let client: 'healthy' | 'failed' | undefined;
        let connects = 0;
        const engine = yield* makeMessagingEngine(
          {
            ...original,
            connect: () =>
              Effect.gen(function* () {
                if (client) return;
                connects += 1;
                client = connects === 2 ? 'failed' : 'healthy';
                yield* original.connect(credentials);
              }),
            disconnect: () =>
              Effect.gen(function* () {
                client = undefined;
                yield* original.disconnect();
              }),
            isAuthorized: () =>
              client === 'failed'
                ? Effect.fail(createMtprotoError('transport', 'Failed connection'))
                : original.isAuthorized(),
          },
          makeMemoryCacheStore(),
          { manageTabLease: false },
        );
        yield* engine.start(credentials);
        window.__televechaFixture?.emit({ type: 'connection-state', connected: false });
        yield* Effect.yieldNow;
        yield* TestClock.adjust('1 second');
        expect(engine.snapshot().online).toBe(false);
        expect(client).toBeUndefined();
        yield* TestClock.adjust('2 seconds');
        expect(connects).toBe(3);
        expect(engine.snapshot().online).toBe(true);
        yield* engine.stop();
      }).pipe(Effect.provide(TestClock.layer())),
    ));

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
