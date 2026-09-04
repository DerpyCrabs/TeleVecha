import {
  Context,
  Effect,
  Equal,
  Fiber,
  FiberSet,
  Layer,
  Option,
  PubSub,
  Ref,
  Stream,
} from 'effect';

import type {
  AccountSnapshot,
  ConversationViewSnapshot,
  EngineSnapshot,
  TelegramConversationEvent,
  TelegramResourceInvalidation,
} from '../types';

const accountKeys = [
  'phase',
  'sync',
  'online',
  'dialogs',
  'drafts',
  'draftDetails',
  'pending',
  'activities',
  'authStep',
  'codeViaApp',
  'operationError',
  'error',
  'requiresReload',
] as const satisfies readonly (keyof AccountSnapshot)[];

export function accountSnapshot(snapshot: AccountSnapshot): AccountSnapshot {
  return {
    phase: snapshot.phase,
    sync: snapshot.sync,
    online: snapshot.online,
    dialogs: snapshot.dialogs,
    drafts: snapshot.drafts,
    draftDetails: snapshot.draftDetails,
    pending: snapshot.pending,
    activities: snapshot.activities,
    ...(snapshot.authStep === undefined ? {} : { authStep: snapshot.authStep }),
    ...(snapshot.codeViaApp === undefined ? {} : { codeViaApp: snapshot.codeViaApp }),
    ...(snapshot.operationError === undefined ? {} : { operationError: snapshot.operationError }),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    ...(snapshot.requiresReload === undefined ? {} : { requiresReload: snapshot.requiresReload }),
  };
}

export function mergeAccountSnapshot(previous: EngineSnapshot, next: AccountSnapshot) {
  if (accountKeys.every((key) => previous[key] === next[key])) return previous;

  const {
    authStep: _authStep,
    codeViaApp: _codeViaApp,
    operationError: _operationError,
    error: _error,
    requiresReload: _requiresReload,
    ...conversationAndRequiredAccount
  } = previous;
  return { ...conversationAndRequiredAccount, ...accountSnapshot(next) };
}

export function conversationViewSnapshot(snapshot: EngineSnapshot): ConversationViewSnapshot {
  const {
    activePeerId,
    messages,
    loadingMessages,
    hasOlderMessages,
    loadingOlderMessages,
    sharedMediaCounts,
    pinnedMessages,
    historyGaps,
    historyError,
    historyRetryAt,
  } = snapshot;
  return {
    ...(activePeerId === undefined ? {} : { activePeerId }),
    messages,
    loadingMessages,
    hasOlderMessages,
    loadingOlderMessages,
    ...(sharedMediaCounts === undefined ? {} : { sharedMediaCounts }),
    pinnedMessages,
    historyGaps,
    ...(historyError === undefined ? {} : { historyError }),
    ...(historyRetryAt === undefined ? {} : { historyRetryAt }),
  };
}

export function engineSnapshot(
  account: AccountSnapshot,
  conversation: ConversationViewSnapshot,
): EngineSnapshot {
  return { ...account, ...conversation };
}

/**
 * Reuses top-level values that are structurally unchanged. Snapshot producers
 * may deserialize or refetch equal arrays and records, but observers should see
 * those as the same state.
 */
export function shareEqualSnapshotFields<Snapshot>(previous: Snapshot, next: Snapshot): Snapshot {
  if (Object.is(previous, next)) return previous;
  if (
    typeof previous !== 'object' ||
    previous === null ||
    typeof next !== 'object' ||
    next === null
  ) {
    return Equal.equals(previous, next) ? previous : next;
  }

  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const previousKeys = Object.keys(previousRecord);
  const nextKeys = Object.keys(nextRecord);
  const shared = { ...nextRecord };
  let changed = previousKeys.length !== nextKeys.length;

  for (const key of nextKeys) {
    if (!Object.hasOwn(previousRecord, key)) {
      changed = true;
      continue;
    }
    const previousValue = previousRecord[key];
    const nextValue = nextRecord[key];
    if (Object.is(previousValue, nextValue)) continue;
    if (Equal.equals(previousValue, nextValue)) shared[key] = previousValue;
    else changed = true;
  }

  return changed ? (shared as Snapshot) : previous;
}

interface State<Snapshot> {
  readonly snapshot: Snapshot;
  readonly notificationBatchDepth: number;
  readonly notificationPending: boolean;
}

const initialAccountSnapshot = (): AccountSnapshot => ({
  phase: 'idle',
  sync: 'stale',
  online: false,
  dialogs: [],
  drafts: {},
  draftDetails: {},
  pending: [],
  activities: [],
});

export const initialEngineSnapshot = (): EngineSnapshot => ({
  ...initialAccountSnapshot(),
  messages: [],
  loadingMessages: false,
  hasOlderMessages: false,
  loadingOlderMessages: false,
  pinnedMessages: [],
  historyGaps: [],
});

const makeSnapshotState = <Snapshot>(initial: Snapshot) =>
  Effect.gen(function* () {
    const state = yield* Ref.make<State<Snapshot>>({
      snapshot: initial,
      notificationBatchDepth: 0,
      notificationPending: false,
    });
    const snapshots = yield* PubSub.sliding<Snapshot>({ capacity: 1, replay: 1 });
    const resources = yield* PubSub.bounded<TelegramResourceInvalidation>(256);
    const conversationEvents = yield* PubSub.bounded<TelegramConversationEvent>(256);
    const observers = yield* FiberSet.make<void>();
    yield* PubSub.publish(snapshots, initial);

    const publish = (snapshot: Option.Option<Snapshot>) =>
      Option.isSome(snapshot)
        ? PubSub.publish(snapshots, snapshot.value).pipe(Effect.asVoid)
        : Effect.void;

    const changeSnapshot = Effect.fn('EngineState.changeSnapshot')(function* (
      update: (snapshot: Snapshot) => Snapshot,
    ) {
      const changed = yield* Ref.modify(state, (current) => {
        const snapshot = shareEqualSnapshotFields(current.snapshot, update(current.snapshot));
        if (snapshot === current.snapshot) return [Option.none<Snapshot>(), current];
        if (current.notificationBatchDepth > 0) {
          return [Option.none<Snapshot>(), { ...current, snapshot, notificationPending: true }];
        }
        return [Option.some(snapshot), { ...current, snapshot }];
      });
      yield* publish(changed);
    });

    const set = (snapshot: Snapshot) => changeSnapshot(() => snapshot);
    const patch = (patch: Partial<Snapshot>) =>
      changeSnapshot((snapshot) => ({ ...snapshot, ...patch }));

    const beginNotificationBatch = Ref.update(state, (current) => ({
      ...current,
      notificationBatchDepth: current.notificationBatchDepth + 1,
    }));

    const endNotificationBatch = Effect.gen(function* () {
      const changed = yield* Ref.modify(state, (current) => {
        const notificationBatchDepth = Math.max(0, current.notificationBatchDepth - 1);
        const shouldPublish = notificationBatchDepth === 0 && current.notificationPending;
        return [
          shouldPublish ? Option.some(current.snapshot) : Option.none<Snapshot>(),
          {
            ...current,
            notificationBatchDepth,
            notificationPending: shouldPublish ? false : current.notificationPending,
          },
        ];
      });
      yield* publish(changed);
    });

    return {
      snapshot: Ref.get(state).pipe(Effect.map((current) => current.snapshot)),
      snapshotUnsafe: () => Ref.getUnsafe(state).snapshot,
      changes: Stream.fromPubSub(snapshots),
      resources: Stream.fromPubSub(resources),
      conversationEvents: Stream.fromPubSub(conversationEvents),
      subscribe: (listener: (snapshot: Snapshot) => void) =>
        FiberSet.run(
          observers,
          Stream.runForEach(Stream.fromPubSub(snapshots), (snapshot) =>
            Effect.sync(() => listener(snapshot)),
          ),
          { startImmediately: true },
        ).pipe(Effect.map((fiber) => Fiber.interrupt(fiber))),
      subscribeResources: (listener: (event: TelegramResourceInvalidation) => void) =>
        FiberSet.run(
          observers,
          Stream.runForEach(Stream.fromPubSub(resources), (event) =>
            Effect.sync(() => listener(event)),
          ),
          { startImmediately: true },
        ).pipe(Effect.map((fiber) => Fiber.interrupt(fiber))),
      subscribeConversationEvents: (listener: (event: TelegramConversationEvent) => void) =>
        FiberSet.run(
          observers,
          Stream.runForEach(Stream.fromPubSub(conversationEvents), (event) =>
            Effect.sync(() => listener(event)),
          ),
          { startImmediately: true },
        ).pipe(Effect.map((fiber) => Fiber.interrupt(fiber))),
      set,
      patch,
      invalidateResource: (event: TelegramResourceInvalidation) =>
        PubSub.publish(resources, event).pipe(Effect.asVoid),
      publishConversationEvent: (event: TelegramConversationEvent) =>
        PubSub.publish(conversationEvents, event).pipe(Effect.asVoid),
      beginNotificationBatch,
      endNotificationBatch,
    };
  });

const makeEngineState = makeSnapshotState(initialEngineSnapshot());
const makeAccountState = makeSnapshotState(initialAccountSnapshot());

export type EngineState = Effect.Success<typeof makeEngineState>;
export const EngineState = Context.Service<EngineState>('televecha/telegram/core/EngineState');
export const EngineStateLayer = Layer.effect(EngineState, makeEngineState);
export type AccountState = Effect.Success<typeof makeAccountState>;
export const AccountState = Context.Service<AccountState>('televecha/telegram/core/AccountState');
export const AccountStateLayer = Layer.effect(AccountState, makeAccountState);
