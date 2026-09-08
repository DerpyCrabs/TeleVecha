import { BrowserCrypto } from '@effect/platform-browser';
import { makeMessagingEngine, MessagingEngineLayer } from '../core/engine';
import { createFixtureTelegramTransport } from '../transports/fixtureTransport';
import { makeMemoryCacheStore } from '../persistence/memoryStore';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { EngineStateLayer } from '../core/engineState';
import { CoordinatorTasksLayer } from './coordinatorTasks';
import { makeTabCoordinator } from './tabCoordinator';

const provideCoordinator = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(Layer.merge(EngineStateLayer, CoordinatorTasksLayer)));
afterEach(() => vi.unstubAllGlobals());

class TestChannel {
  addEventListener() {}
  removeEventListener() {}
  postMessage() {}
  close() {}
}

const installChannel = () => {
  vi.stubGlobal('BroadcastChannel', TestChannel);
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
      ) => Promise.resolve(callback({})),
    },
  });
};

it('retains a confirmed send when refresh metadata resolves after the history snapshot', () => {
  installChannel();
  return Effect.runPromise(
    provideCoordinator(
      Effect.gen(function* () {
        const transport = yield* createFixtureTelegramTransport();
        const engine = yield* makeMessagingEngine(transport, makeMemoryCacheStore(), {
          manageTabLease: false,
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let hold = false;
        const coordinator = yield* makeTabCoordinator({
          key: 'reactivity-race',
          loadBlob: () => Effect.succeed(undefined),
          createOwner: () =>
            Effect.succeed({
              engine: {
                ...engine,
                loadConversationPinnedMessages: (peerId: string) =>
                  Effect.gen(function* () {
                    const value = yield* engine.loadConversationPinnedMessages(peerId);
                    if (hold) {
                      yield* Deferred.succeed(entered, undefined);
                      yield* Deferred.await(release);
                    }
                    return value;
                  }),
              },
            }),
        });
        yield* coordinator.start({ apiId: 1, apiHash: 'fixture' });
        yield* Effect.yieldNow;
        const conversation = yield* coordinator.client.openConversation('u:101');
        yield* Effect.yieldNow;
        hold = true;
        yield* coordinator.handleInternalEvent({
          _tag: 'snapshot',
          snapshot: { ...engine.snapshot(), sync: 'recovering' },
        });
        yield* coordinator.handleInternalEvent({ _tag: 'snapshot', snapshot: engine.snapshot() });
        yield* Deferred.await(entered);
        yield* conversation.sendDraft('Confirmed during reload');
        yield* Effect.yieldNow;
        expect(
          coordinator.client.snapshot().messages.some((m) => m.text === 'Confirmed during reload'),
        ).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.sleep(10);
        expect(coordinator.client.snapshot().pending).toEqual([]);
        expect(
          coordinator.client.snapshot().messages.some((m) => m.text === 'Confirmed during reload'),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(MessagingEngineLayer), Effect.provide(BrowserCrypto.layer)),
  );
});

it.each(['send', 'edit', 'delete'] as const)(
  'retains a concurrent %s when an explicit same-peer load finishes',
  (mutation) => {
    installChannel();
    return Effect.runPromise(
      provideCoordinator(
        Effect.gen(function* () {
          const transport = yield* createFixtureTelegramTransport();
          const engine = yield* makeMessagingEngine(transport, makeMemoryCacheStore(), {
            manageTabLease: false,
          });
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let hold = false;
          const coordinator = yield* makeTabCoordinator({
            key: 'explicit-load-race',
            loadBlob: () => Effect.succeed(undefined),
            createOwner: () =>
              Effect.succeed({
                engine: {
                  ...engine,
                  loadConversationView: (peerId: string) =>
                    Effect.gen(function* () {
                      const value = yield* engine.loadConversationView(peerId);
                      if (hold) {
                        yield* Deferred.succeed(entered, undefined);
                        yield* Deferred.await(release);
                      }
                      return value;
                    }),
                },
              }),
          });
          yield* coordinator.start({ apiId: 1, apiHash: 'fixture' });
          yield* Effect.yieldNow;
          const conversation = yield* coordinator.client.openConversation('u:101');
          yield* Effect.yieldNow;
          const target = coordinator.client.snapshot().messages.find(({ outgoing }) => outgoing)!;
          expect(target).toBeDefined();
          hold = true;
          const reopening = yield* coordinator.client
            .openConversation('u:101')
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          if (mutation === 'send') yield* conversation.sendDraft('New during load');
          else if (mutation === 'edit')
            yield* conversation.editMessage(target.id, 'Edited during load');
          else yield* conversation.deleteMessage(target.id, false);
          yield* Effect.yieldNow;
          const verify = () => {
            const messages = coordinator.client.snapshot().messages;
            if (mutation === 'send')
              expect(messages.some(({ text }) => text === 'New during load')).toBe(true);
            else if (mutation === 'edit')
              expect(messages.find(({ id }) => id === target.id)?.text).toBe('Edited during load');
            else expect(messages.some(({ id }) => id === target.id)).toBe(false);
          };
          verify();
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(reopening);
          yield* Effect.yieldNow;
          verify();
        }),
      ).pipe(Effect.provide(MessagingEngineLayer), Effect.provide(BrowserCrypto.layer)),
    );
  },
);

it('retains a live pinned-message update while initial conversation metadata is loading', () => {
  installChannel();
  return Effect.runPromise(
    provideCoordinator(
      Effect.gen(function* () {
        const transport = yield* createFixtureTelegramTransport();
        const engine = yield* makeMessagingEngine(transport, makeMemoryCacheStore(), {
          manageTabLease: false,
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const coordinator = yield* makeTabCoordinator({
          key: 'pinned-load-race',
          loadBlob: () => Effect.succeed(undefined),
          createOwner: () =>
            Effect.succeed({
              engine: {
                ...engine,
                loadConversationPinnedMessages: (peerId: string) =>
                  Effect.gen(function* () {
                    const captured = yield* engine.loadConversationPinnedMessages(peerId);
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                    return captured;
                  }),
              },
            }),
        });
        yield* coordinator.start({ apiId: 1, apiHash: 'fixture' });
        yield* Effect.yieldNow;
        yield* coordinator.client.openConversation('u:101');
        yield* Effect.yieldNow;
        yield* Deferred.await(entered);
        yield* Effect.sleep(1);
        const pinned = {
          ...coordinator.client.snapshot().messages[0]!,
          text: 'New pin during metadata',
        };
        yield* coordinator.handleInternalEvent({
          _tag: 'conversation',
          event: { type: 'pinned-messages', peerId: 'u:101', messages: [pinned] },
        });
        expect(coordinator.client.snapshot().pinnedMessages).toEqual([pinned]);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.sleep(10);
        expect(coordinator.client.snapshot().pinnedMessages).toEqual([pinned]);
      }),
    ).pipe(Effect.provide(MessagingEngineLayer), Effect.provide(BrowserCrypto.layer)),
  );
});
