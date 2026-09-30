import type { TelegramMessage } from '../types';
import { BrowserCrypto } from '@effect/platform-browser';
import { makeMessagingEngine, MessagingEngineLayer } from '../core/engine';
import { createFixtureTelegramTransport } from '../transports/fixtureTransport';
import { makeMemoryCacheStore } from '../persistence/memoryStore';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accountSnapshot,
  conversationViewSnapshot,
  initialEngineSnapshot,
  EngineStateLayer,
} from '../core/engineState';
import { CoordinatorTasksLayer } from './coordinatorTasks';
import { makeTabCoordinator } from './tabCoordinator';

const CHANNEL_ERROR = 'This browser cannot provide the channel required for safe multi-tab sync.';

const makeUnavailableCoordinator = () =>
  makeTabCoordinator({
    key: 'test',
    createOwner: () => Effect.die('an unavailable coordinator cannot elect an owner'),
    loadBlob: () => Effect.succeed(undefined),
  });

const provideCoordinator = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(Layer.merge(EngineStateLayer, CoordinatorTasksLayer)));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tab coordinator', () => {
  it('exposes an error snapshot when BroadcastChannel is unavailable', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });

    return Effect.runPromise(
      provideCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* makeUnavailableCoordinator();
          expect(coordinator.client.snapshot()).toMatchObject({
            phase: 'error',
            online: false,
            error: CHANNEL_ERROR,
          });
        }),
      ),
    );
  });

  it('keeps transport failures in the Effect error channel', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });

    return Effect.runPromise(
      provideCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* makeUnavailableCoordinator();
          const result = yield* coordinator.client.refreshUpdates().pipe(Effect.result);

          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'MessagingError', operation: 'refreshUpdates' },
          });
        }),
      ),
    );
  });

  it('uses the Telegram webpage document identity for cross-tab media caching', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });

    return Effect.runPromise(
      provideCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* makeUnavailableCoordinator();
          expect(
            coordinator.client.mediaAssetKey({
              id: 7,
              peerId: 'u:1',
              senderId: 'u:1',
              text: 'video',
              date: 1,
              outgoing: false,
              linkPreview: {
                url: 'https://example.invalid/video',
                media: {
                  kind: 'video',
                  name: 'video.mp4',
                  mimeType: 'video/mp4',
                  cacheKey: 'document:99',
                },
              },
            }),
          ).toBe('media:u:1:7:webpage-video-v2:document:99');
        }),
      ),
    );
  });
});

class RecordingChannel {
  static latest: RecordingChannel;
  readonly sent: Record<string, unknown>[] = [];
  constructor() {
    RecordingChannel.latest = this;
  }
  addEventListener() {}
  removeEventListener() {}
  postMessage(message: Record<string, unknown>) {
    this.sent.push(message);
  }
  close() {}
  get hello() {
    const hello = this.sent.find((message) => message.type === 'hello' || message.type === 'owner');
    if (!hello) throw new Error('Coordinator did not announce itself');
    return hello;
  }
}

const installChannel = (owner: boolean = false) => {
  vi.stubGlobal('BroadcastChannel', RecordingChannel);
  vi.stubGlobal('window', {
    location: { search: '' },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('navigator', {
    locks: {
      request: (
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<void> | void,
      ) => Promise.resolve(callback(owner ? {} : null)),
    },
  });
};

describe('tab coordinator request and hydration regressions', () => {
  it('preserves byte ranges when forwarding media requests to the owner', () => {
    installChannel(true);
    return Effect.runPromise(
      provideCoordinator(
        Effect.gen(function* () {
          const transport = yield* createFixtureTelegramTransport();
          const store = makeMemoryCacheStore();
          const download = vi
            .spyOn(transport, 'downloadMedia')
            .mockImplementation((_message, options) =>
              Effect.succeed(new Blob([`${options?.range?.start}-${options?.range?.end}`])),
            );
          const engine = yield* makeMessagingEngine(transport, store, { manageTabLease: false });
          const coordinator = yield* makeTabCoordinator({
            key: 'video-range',
            loadBlob: (key) => store.loadBlob(key),
            createOwner: () => Effect.succeed({ engine }),
          });
          yield* coordinator.start({ apiId: 1, apiHash: 'fixture' });
          const message = {
            id: 700,
            peerId: 'u:101',
            senderId: 'u:101',
            date: 1,
            text: '',
            outgoing: false,
          };
          const blob = yield* coordinator.client.downloadMedia(message, {
            range: { start: 123, end: 456 },
          });
          expect(yield* Effect.promise(() => blob.text())).toBe('123-456');
          expect(download).toHaveBeenCalledWith(
            message,
            expect.objectContaining({ range: { start: 123, end: 456 } }),
          );
          yield* store.saveBlob(
            engine.mediaAssetKey(message),
            new Blob(['0123456789'], { type: 'video/mp4' }),
          );
          const cached = yield* coordinator.client.downloadMedia(message, {
            range: { start: 2, end: 4 },
          });
          expect(yield* Effect.promise(() => cached.text())).toBe('234');
          expect(download).toHaveBeenCalledTimes(1);
        }),
      ).pipe(Effect.provide(MessagingEngineLayer), Effect.provide(BrowserCrypto.layer)),
    );
  });

  it('keeps a confirmed send visible in the selected conversation', () => {
    installChannel(true);
    return Effect.runPromise(
      provideCoordinator(
        Effect.gen(function* () {
          const transport = yield* createFixtureTelegramTransport();
          const engine = yield* makeMessagingEngine(transport, makeMemoryCacheStore(), {
            manageTabLease: false,
          });
          const coordinator = yield* makeTabCoordinator({
            key: 'visible-send',
            loadBlob: () => Effect.succeed(undefined),
            createOwner: () => Effect.succeed({ engine }),
          });
          yield* coordinator.start({ apiId: 1, apiHash: 'fixture' });
          yield* Effect.yieldNow;
          const conversation = yield* coordinator.client.openConversation('u:101');
          yield* conversation.sendDraft('Confirmed message');
          yield* Effect.yieldNow;
          expect(coordinator.client.snapshot().pending).toEqual([]);
          expect(coordinator.client.snapshot().messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ text: 'Confirmed message', outgoing: true }),
            ]),
          );
        }),
      ).pipe(Effect.provide(MessagingEngineLayer), Effect.provide(BrowserCrypto.layer)),
    );
  });

  it('publishes history reloads and shared-media counts while pinned messages are still loading', () => {
    installChannel(true);
    return Effect.runPromise(
      provideCoordinator(
        Effect.gen(function* () {
          const transport = yield* createFixtureTelegramTransport();
          const engine = yield* makeMessagingEngine(
            { ...transport, getPinnedMessages: () => Effect.never },
            makeMemoryCacheStore(),
            { manageTabLease: false },
          );
          let listener: Parameters<typeof engine.subscribeConversationEvents>[0] | undefined;
          let reloaded = false;
          const coordinator = yield* makeTabCoordinator({
            key: 'held-pinned-reload',
            loadBlob: () => Effect.succeed(undefined),
            createOwner: () =>
              Effect.succeed({
                engine: {
                  ...engine,
                  subscribeConversationEvents: (next) => {
                    listener = next;
                    return engine.subscribeConversationEvents(next);
                  },
                  loadConversationView: (peerId) =>
                    engine
                      .loadConversationView(peerId)
                      .pipe(
                        Effect.map((view) => ({
                          ...view,
                          messages: reloaded
                            ? view.messages.map((message) =>
                                message.id === 80
                                  ? { ...message, text: 'Reloaded history' }
                                  : message,
                              )
                            : view.messages,
                        })),
                      ),
                },
              }),
          });
          yield* coordinator.start({ apiId: 1, apiHash: 'fixture' });
          yield* Effect.yieldNow;
          const countsPublished = yield* Deferred.make<void>();
          const stopCounts = yield* coordinator.client.subscribe((snapshot) => {
            if (snapshot.sharedMediaCounts !== undefined)
              Deferred.doneUnsafe(countsPublished, Effect.void);
          });
          yield* coordinator.client.openConversation('u:101');
          yield* Deferred.await(countsPublished).pipe(Effect.timeout('1 second'));
          yield* stopCounts;
          expect(coordinator.client.snapshot().sharedMediaCounts).toBeDefined();
          const published = yield* Deferred.make<void>();
          const unsubscribe = yield* coordinator.client.subscribe((snapshot) => {
            if (snapshot.messages.at(-1)?.text === 'Reloaded history')
              Deferred.doneUnsafe(published, Effect.void);
          });
          reloaded = true;
          listener!({ type: 'history-reset', peerId: 'u:101' });
          yield* Deferred.await(published).pipe(Effect.timeout('1 second'));
          expect(coordinator.client.snapshot().loadingMessages).toBe(false);
          expect(coordinator.client.snapshot().messages.at(-1)?.text).toBe('Reloaded history');
          yield* unsubscribe;
        }),
      ).pipe(Effect.provide(MessagingEngineLayer), Effect.provide(BrowserCrypto.layer)),
    );
  });

  it('executes a repeated request once while in flight and replays its completed response', () => {
    installChannel(true);
    return Effect.runPromise(
      provideCoordinator(
        Effect.gen(function* () {
          const transport = yield* createFixtureTelegramTransport();
          const engine = yield* makeMessagingEngine(transport, makeMemoryCacheStore(), {
            manageTabLease: false,
          });
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let executions = 0;
          const coordinator = yield* makeTabCoordinator({
            key: 'request-replay',
            loadBlob: () => Effect.succeed(undefined),
            createOwner: () =>
              Effect.succeed({
                engine: {
                  ...engine,
                  setMuted: (peer, muted) =>
                    Effect.gen(function* () {
                      executions += 1;
                      yield* Deferred.succeed(entered, undefined);
                      yield* Deferred.await(release);
                      return yield* engine.setMuted(peer, muted);
                    }),
                },
              }),
          });
          const channel = RecordingChannel.latest;
          yield* coordinator.start({ apiId: 1, apiHash: 'fixture' });
          const request = {
            type: 'request',
            version: channel.hello.version,
            from: 'follower',
            id: 'same-intent',
            method: 'setMuted',
            args: [{ id: 'u:101', kind: 'user' }, true],
          };
          yield* coordinator.receive(request);
          yield* Deferred.await(entered);
          yield* coordinator.receive(request);
          expect(executions).toBe(1);
          yield* Deferred.succeed(release, undefined);
          yield* Effect.yieldNow;
          const responses = () =>
            channel.sent.filter(
              (message) => message.type === 'response' && message.id === 'same-intent',
            );
          expect(responses()).toHaveLength(1);
          yield* coordinator.receive(request);
          expect(executions).toBe(1);
          expect(responses()).toHaveLength(2);
          expect(responses()[1]).toEqual(responses()[0]);
        }),
      ).pipe(Effect.provide(MessagingEngineLayer), Effect.provide(BrowserCrypto.layer)),
    );
  });

  it('rejects a pending request when its elected owner disappears', () => {
    installChannel();
    return Effect.runPromise(
      provideCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* makeUnavailableCoordinator();
          yield* coordinator.start({ apiId: 1, apiHash: 'fixture' });
          const hello = RecordingChannel.latest.hello;
          const owner = { from: 'owner', version: hello.version };
          yield* coordinator.receive({ ...owner, type: 'owner', at: Date.now() });
          const requestSent = yield* Deferred.make<void>();
          const channel = RecordingChannel.latest;
          vi.spyOn(channel, 'postMessage').mockImplementation((message) => {
            channel.sent.push(message);
            if (message.type === 'request') Deferred.doneUnsafe(requestSent, Effect.void);
          });
          const pending = yield* coordinator.client
            .refreshUpdates()
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(requestSent).pipe(Effect.timeout('1 second'));
          yield* coordinator.receive({ ...owner, type: 'owner-gone' });
          const result = yield* Fiber.join(pending);
          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: {
              _tag: 'MessagingError',
              message: expect.stringContaining('closed during the command') as unknown,
            },
          });
        }),
      ),
    );
  });

  it('joins an owner whose dialog and conversation contain optional rich-message fields', () => {
    installChannel();
    return Effect.runPromise(
      provideCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* makeUnavailableCoordinator();
          yield* coordinator.start({ apiId: 1, apiHash: 'fixture' });
          const hello = RecordingChannel.latest.hello;
          const owner = { from: 'owner', version: hello.version };
          yield* coordinator.receive({ ...owner, type: 'owner', at: Date.now() });
          const message: TelegramMessage = {
            id: 81,
            peerId: 'u:101',
            senderId: 'u:101',
            text: '',
            date: 1,
            outgoing: false,
            richMessage: {
              rtl: undefined,
              partial: false,
              blocks: [
                { kind: 'pre', text: { kind: 'text', text: 'hello' }, language: undefined },
                {
                  kind: 'list',
                  ordered: false,
                  items: [
                    { text: { kind: 'text', text: 'item' }, checked: undefined, blocks: undefined },
                  ],
                },
              ],
            },
          };
          const snapshot = {
            ...initialEngineSnapshot(),
            phase: 'ready' as const,
            online: true,
            activePeerId: 'u:101',
            messages: [message],
            pinnedMessages: [message],
            dialogs: [
              {
                peer: { id: 'u:101', kind: 'user' as const },
                title: 'Alice',
                initials: 'A',
                color: '#123456',
                hasAvatar: false,
                topMessageId: 81,
                topMessage: message,
                unreadCount: 0,
                readInboxMaxId: 81,
                readOutboxMaxId: 0,
                muted: false,
                pinned: false,
              },
            ],
          };
          yield* coordinator.receive(
            structuredClone({
              ...owner,
              type: 'state',
              to: hello.from,
              account: accountSnapshot(snapshot),
              conversation: conversationViewSnapshot(snapshot),
            }),
          );
          yield* Effect.yieldNow;
          expect(coordinator.client.snapshot().phase).toBe('ready');
          expect(coordinator.client.snapshot().dialogs[0]?.topMessage?.richMessage).toEqual(
            message.richMessage,
          );
          expect(coordinator.client.snapshot().messages[0]?.richMessage).toEqual(
            message.richMessage,
          );
          expect(coordinator.client.snapshot().pinnedMessages[0]?.richMessage).toEqual(
            message.richMessage,
          );
        }),
      ),
    );
  });

  it('rejects stale hydration and state from anyone except the elected owner', () => {
    installChannel();
    return Effect.runPromise(
      provideCoordinator(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const coordinator = yield* makeTabCoordinator({
            key: 'hydration',
            createOwner: () => Effect.die('This test remains a follower'),
            loadBlob: () => Effect.succeed(undefined),
            hydrateSnapshot: (snapshot) =>
              snapshot.error === 'older'
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(snapshot),
                  )
                : Effect.succeed(snapshot),
          });
          yield* coordinator.start({ apiId: 1, apiHash: 'fixture' });
          const hello = RecordingChannel.latest.hello;
          const owner = { from: 'owner', version: hello.version };
          yield* coordinator.receive({ ...owner, type: 'owner', at: Date.now() });
          const state = (error: string) => ({
            ...owner,
            type: 'state',
            to: hello.from,
            account: accountSnapshot({
              ...initialEngineSnapshot(),
              phase: 'ready',
              online: true,
              error,
            }),
            conversation: conversationViewSnapshot(initialEngineSnapshot()),
          });
          yield* coordinator.receive(state('older'));
          yield* Deferred.await(entered);
          yield* coordinator.receive(state('newer'));
          yield* coordinator.receive({ ...state('forged'), from: 'another-tab' });
          yield* Deferred.succeed(release, undefined);
          yield* Effect.yieldNow;
          expect(coordinator.client.snapshot().error).toBe('newer');
        }),
      ),
    );
  });
});
