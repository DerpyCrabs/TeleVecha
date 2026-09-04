import {
  Context,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FiberSet,
  Layer,
  Option,
  RcMap,
  Schedule,
  Semaphore,
} from 'effect';

type EngineDelay = 'activity' | 'inboxRead';
export type EngineSerialLane =
  | 'dialogState'
  | 'draftWrite'
  | 'metadataWrite'
  | 'mutation'
  | 'outboxDelivery'
  | 'outboxWrite'
  | 'reaction'
  | 'update';
type EngineRetrySlot = 'reconnect';

const retryDelays: Record<EngineRetrySlot, readonly [initial: number, maximum: number]> = {
  reconnect: [1_000, 30_000],
};

const serialLanes: readonly EngineSerialLane[] = [
  'dialogState',
  'draftWrite',
  'metadataWrite',
  'mutation',
  'outboxDelivery',
  'outboxWrite',
  'reaction',
  'update',
];

const makeEngineTasks = Effect.gen(function* () {
  const lifecycle = yield* FiberSet.make<unknown, unknown>();
  const network = yield* FiberSet.make<unknown, unknown>();
  const background = yield* FiberSet.make<void, unknown>();
  const activityDelays = yield* FiberMap.make<string, void>();
  const inboxReadDelays = yield* FiberMap.make<string, void>();
  const retries = yield* FiberMap.make<EngineRetrySlot, void>();
  const operations = yield* FiberMap.make<string, void, unknown>();
  const semaphores = yield* RcMap.make({
    lookup: () => Semaphore.make(1),
  });
  const serial = {
    dialogState: yield* FiberSet.make<unknown, unknown>(),
    draftWrite: yield* FiberSet.make<unknown, unknown>(),
    metadataWrite: yield* FiberSet.make<unknown, unknown>(),
    mutation: yield* FiberSet.make<unknown, unknown>(),
    outboxDelivery: yield* FiberSet.make<unknown, unknown>(),
    outboxWrite: yield* FiberSet.make<unknown, unknown>(),
    reaction: yield* FiberSet.make<unknown, unknown>(),
    update: yield* FiberSet.make<unknown, unknown>(),
  } satisfies Record<EngineSerialLane, FiberSet.FiberSet<unknown, unknown>>;
  const delayMap = (slot: EngineDelay) => (slot === 'activity' ? activityDelays : inboxReadDelays);
  const runTracked = <Value, Error, Requirements>(
    set: FiberSet.FiberSet<unknown, unknown>,
    effect: Effect.Effect<Value, Error, Requirements>,
  ) =>
    Effect.gen(function* () {
      const fiber = yield* FiberSet.run(set, Effect.exit(effect));
      const result = yield* Fiber.join(fiber);
      if (Exit.isSuccess(result)) return result.value;
      return yield* Effect.failCause(result.cause);
    });

  return {
    runExclusive: <Error, Requirements>(
      key: string,
      operation: Effect.Effect<void, Error, Requirements>,
    ) =>
      Effect.gen(function* () {
        const current = yield* FiberMap.get(operations, key);
        if (Option.isSome(current)) return yield* Fiber.join(current.value);
        const fiber = yield* FiberMap.run(operations, key, operation);
        return yield* Fiber.join(fiber);
      }),
    awaitOperation: (key: string) =>
      FiberMap.get(operations, key).pipe(
        Effect.flatMap((current) =>
          Option.isSome(current) ? Fiber.join(current.value) : Effect.void,
        ),
      ),
    interruptOperation: (key: string) => FiberMap.remove(operations, key),
    // Accepted mutations and storage writes belong to the session. Stop drains
    // these even if the initiating UI request has gone away.
    runSession: <Value, Error, Requirements>(effect: Effect.Effect<Value, Error, Requirements>) =>
      runTracked(lifecycle, effect),
    runNetwork: <Value, Error, Requirements>(effect: Effect.Effect<Value, Error, Requirements>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const fiber = yield* FiberSet.run(network, restore(Effect.exit(effect)));
          const result = yield* restore(Fiber.join(fiber)).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(fiber)),
          );
          return Exit.isSuccess(result) ? result.value : yield* Effect.failCause(result.cause);
        }),
      ),
    forkBackground: <Error, Requirements>(effect: Effect.Effect<void, Error, Requirements>) =>
      FiberSet.run(background, effect).pipe(Effect.asVoid),
    drain: FiberSet.awaitEmpty(lifecycle),
    interruptNetwork: FiberSet.clear(network),
    interruptBackground: FiberSet.clear(background),
    hasDelay: (slot: EngineDelay, key: string) => FiberMap.has(delayMap(slot), key),
    delay: (
      slot: EngineDelay,
      key: string,
      delayMs: number,
      action: Effect.Effect<void>,
      options?: { readonly onlyIfMissing?: boolean },
    ) =>
      Effect.gen(function* () {
        const timer = yield* FiberMap.run(delayMap(slot), key, Effect.sleep(delayMs), options);
        yield* FiberSet.run(background, Fiber.join(timer).pipe(Effect.andThen(action)));
      }),
    cancelDelay: (slot: EngineDelay, key: string) => FiberMap.remove(delayMap(slot), key),
    clearDelays: (slot?: EngineDelay) =>
      slot
        ? FiberMap.clear(delayMap(slot))
        : Effect.all([FiberMap.clear(activityDelays), FiberMap.clear(inboxReadDelays)]).pipe(
            Effect.asVoid,
          ),
    retry: (slot: EngineRetrySlot, attempt: Effect.Effect<boolean, unknown>) => {
      const [initial, maximum] = retryDelays[slot];
      return FiberMap.run(
        retries,
        slot,
        Effect.sleep(initial).pipe(
          Effect.andThen(
            attempt.pipe(
              Effect.repeat({
                schedule: Schedule.min([
                  Schedule.exponential(Math.min(maximum, initial * 2)),
                  Schedule.spaced(maximum),
                ]),
                while: (again) => again,
              }),
              Effect.asVoid,
            ),
          ),
        ),
        { onlyIfMissing: true },
      ).pipe(Effect.asVoid);
    },
    cancelRetry: (slot: EngineRetrySlot) => FiberMap.remove(retries, slot),
    serialize: <Value, Error, Requirements>(
      lane: EngineSerialLane,
      key: string,
      operation: Effect.Effect<Value, Error, Requirements>,
    ) =>
      runTracked(
        serial[lane],
        Effect.scoped(
          RcMap.get(semaphores, `${lane}\u0000${key}`).pipe(
            Effect.flatMap((semaphore) => Semaphore.withPermit(semaphore)(operation)),
          ),
        ),
      ),
    drainSerial: (lanes: readonly EngineSerialLane[] = serialLanes) =>
      Effect.forEach(lanes, (lane) => FiberSet.awaitEmpty(serial[lane]), {
        concurrency: 'unbounded',
        discard: true,
      }),
  };
});

export type EngineTasks = Effect.Success<typeof makeEngineTasks>;
export const EngineTasks = Context.Service<EngineTasks>('televecha/telegram/core/EngineTasks');
export const EngineTasksLayer = Layer.effect(EngineTasks, makeEngineTasks);
