import { Deferred, Effect, Fiber, Stream } from 'effect';
import { describe, expect, it } from 'vitest';

import {
  EngineState,
  accountSnapshot,
  EngineStateLayer,
  initialEngineSnapshot,
  mergeAccountSnapshot,
  shareEqualSnapshotFields,
} from './engineState';
import type { TelegramResourceInvalidation } from '../types';

const run = <Value>(effect: Effect.Effect<Value, never, EngineState>) =>
  Effect.runPromise(effect.pipe(Effect.provide(EngineStateLayer)));

describe('EngineState', () => {
  it('propagates rotated QR tokens to other tabs and clears them on leaving QR login', () => {
    const previous = {
      ...initialEngineSnapshot(),
      authStep: 'qr' as const,
      qrLogin: { url: 'tg://login?token=old', expires: 10 },
    };
    const next = { ...previous, qrLogin: { url: 'tg://login?token=new', expires: 40 } };
    expect(mergeAccountSnapshot(previous, accountSnapshot(next)).qrLogin).toEqual(next.qrLogin);
    expect(
      mergeAccountSnapshot(
        next,
        accountSnapshot({ ...next, authStep: 'phone', qrLogin: undefined }),
      ).qrLogin,
    ).toBeUndefined();
  });

  it('shares equal fields and returns the previous snapshot for a no-op replacement', () => {
    const previous = {
      ...initialEngineSnapshot(),
      dialogs: [
        {
          peer: { id: 'peer-1', kind: 'user' as const },
          title: 'Same dialog',
          initials: 'SD',
          color: '#000',
          topMessageId: 1,
          unreadCount: 0,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          muted: false,
          pinned: false,
          hasAvatar: false,
        },
      ],
    };
    const equal = structuredClone(previous);

    expect(shareEqualSnapshotFields(previous, equal)).toBe(previous);

    const changed = shareEqualSnapshotFields(previous, { ...equal, phase: 'connecting' as const });
    expect(changed).not.toBe(previous);
    expect(changed.dialogs).toBe(previous.dialogs);
  });

  it('does not publish structurally equal snapshots', async () => {
    const phases = await run(
      EngineState.use((state) =>
        Effect.gen(function* () {
          const received: string[] = [];
          const unsubscribe = yield* state.subscribe((snapshot) => received.push(snapshot.phase));
          const current = yield* state.snapshot;
          yield* state.set(structuredClone(current));
          yield* unsubscribe;
          return received;
        }),
      ),
    );

    expect(phases).toEqual(['idle']);
  });

  it('clears optional account fields without replacing the conversation view', () => {
    const previous = {
      ...initialEngineSnapshot(),
      phase: 'ready' as const,
      activePeerId: 'peer-1',
      messages: [
        {
          id: 1,
          peerId: 'peer-1',
          senderId: 'peer-1',
          text: 'Keep this view',
          date: 1,
          outgoing: false,
        },
      ],
      operationError: 'Old outbox error',
      error: 'Old connection error',
    };
    const next = { ...initialEngineSnapshot(), phase: 'ready' as const, online: true };

    const merged = mergeAccountSnapshot(previous, next);

    expect(merged).toMatchObject({
      phase: 'ready',
      online: true,
      activePeerId: 'peer-1',
      messages: previous.messages,
    });
    expect(merged.operationError).toBeUndefined();
    expect(merged.error).toBeUndefined();
  });

  it('publishes the initial snapshot and each patch', async () => {
    const snapshots = await run(
      EngineState.use((state) =>
        Effect.gen(function* () {
          const collected: string[] = [];
          const unsubscribe = yield* state.subscribe((snapshot) => {
            collected.push(snapshot.phase);
          });
          yield* state.patch({ phase: 'connecting' });
          yield* state.patch({ phase: 'ready', online: true });
          yield* unsubscribe;
          return collected;
        }),
      ),
    );

    expect(snapshots).toEqual(['idle', 'connecting', 'ready']);
  });

  it('keeps state current while publishing one snapshot for a nested batch', async () => {
    const result = await run(
      EngineState.use((state) =>
        Effect.gen(function* () {
          const snapshots: string[] = [];
          const unsubscribe = yield* state.subscribe((snapshot) => snapshots.push(snapshot.phase));
          yield* state.beginNotificationBatch;
          yield* state.beginNotificationBatch;
          yield* state.patch({ phase: 'connecting' });
          yield* state.patch({ phase: 'syncing' });
          const duringBatch = yield* state.snapshot;
          yield* state.endNotificationBatch;
          const beforeFinalEnd = [...snapshots];
          yield* state.endNotificationBatch;
          yield* unsubscribe;
          return { duringBatch, beforeFinalEnd, snapshots };
        }),
      ),
    );

    expect(result.duringBatch.phase).toBe('syncing');
    expect(result.beforeFinalEnd).toEqual(['idle']);
    expect(result.snapshots).toEqual(['idle', 'syncing']);
  });

  it('publishes resource invalidations independently from snapshots', async () => {
    const event = { kind: 'expressions' as const };
    const received = await run(
      EngineState.use((state) =>
        Effect.gen(function* () {
          const events: TelegramResourceInvalidation[] = [];
          const unsubscribe = yield* state.subscribeResources((value) => events.push(value));
          yield* state.invalidateResource(event);
          yield* unsubscribe;
          return events;
        }),
      ),
    );

    expect(received).toEqual([event]);
  });

  it('isolates subscriber failures and does not retain a failing initial subscriber', async () => {
    const phases = await Effect.runPromise(
      EngineState.use((state) =>
        Effect.gen(function* () {
          const received: string[] = [];
          const initialFailure = yield* Effect.exit(
            state.subscribe(() => {
              throw new Error('initial observer failed');
            }),
          );
          const unsubscribeThrowing = yield* state.subscribe((snapshot) => {
            if (snapshot.phase !== 'idle') throw new Error('observer failed');
          });
          const unsubscribeHealthy = yield* state.subscribe((snapshot) => {
            received.push(snapshot.phase);
          });

          yield* state.patch({ phase: 'connecting' });
          yield* state.patch({ phase: 'ready' });
          yield* unsubscribeThrowing;
          yield* unsubscribeHealthy;
          return { initialFailure, received };
        }),
      ).pipe(Effect.provide(EngineStateLayer)),
    );

    expect(phases.initialFailure._tag).toBe('Success');
    expect(phases.received).toEqual(['idle', 'connecting', 'ready']);
  });
  it('backpressures a blocked delta consumer without losing events', () =>
    run(
      EngineState.use((state) =>
        Effect.scoped(
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const received: number[] = [];
            const consumer = yield* state.conversationEvents.pipe(
              Stream.take(301),
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event.type !== 'messages-delete') return;
                  received.push(...event.messageIds);
                  if (received.length === 1) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                }),
              ),
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            yield* state.publishConversationEvent({
              type: 'messages-delete',
              peerId: 'u:101',
              messageIds: [0],
            });
            yield* Deferred.await(entered);
            const publisher = yield* Effect.forEach(
              Array.from({ length: 300 }, (_, i) => i + 1),
              (id) =>
                state.publishConversationEvent({
                  type: 'messages-delete',
                  peerId: 'u:101',
                  messageIds: [id],
                }),
            ).pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            expect(publisher.pollUnsafe()).toBeUndefined();
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(publisher);
            yield* Fiber.join(consumer);
            expect(received).toEqual(Array.from({ length: 301 }, (_, i) => i));
          }),
        ),
      ),
    ));
});

it('preserves unchanged dialog and message entities before projection across refetched edits and reorders', () => {
  const previous = {
    ...initialEngineSnapshot(),
    messages: [
      { id: 1, peerId: 'a', senderId: 'a', text: 'first', date: 1, outgoing: false },
      { id: 1, peerId: 'b', senderId: 'b', text: 'second', date: 1, outgoing: false },
      { id: 2, peerId: 'a', senderId: 'a', text: 'third', date: 1, outgoing: false },
    ],
  };
  const next = structuredClone(previous);
  next.messages.reverse();
  next.messages[1]!.text = 'edited';
  const shared = shareEqualSnapshotFields(previous, next);
  expect(shared.messages).toEqual(next.messages);
  expect(shared.messages[0]).toBe(previous.messages[2]);
  expect(shared.messages[2]).toBe(previous.messages[0]);
  expect(shared.messages[1]).not.toBe(previous.messages[1]);
  expect(previous.messages[1]!.text).toBe('second');
});
