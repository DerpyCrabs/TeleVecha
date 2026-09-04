import { Context, Effect, Fiber, FiberMap, Layer, Option, Semaphore } from 'effect';

type CoordinatorTask = 'election' | 'heartbeat' | 'monitor' | 'state';

const makeCoordinatorTasks = Effect.gen(function* () {
  const scheduled = yield* FiberMap.make<CoordinatorTask, void>();
  const operations = yield* Semaphore.make(1);
  return {
    runExclusive: <Error, Requirements>(
      task: CoordinatorTask,
      operation: Effect.Effect<void, Error, Requirements>,
    ) =>
      Effect.gen(function* () {
        const current = yield* FiberMap.get(scheduled, task);
        if (Option.isSome(current)) return yield* Fiber.join(current.value);
        const fiber = yield* FiberMap.run(scheduled, task, operation);
        return yield* Fiber.join(fiber);
      }),
    has: (task: CoordinatorTask) => FiberMap.has(scheduled, task),
    repeat: <Error, Requirements>(
      task: CoordinatorTask,
      intervalMs: number,
      action: Effect.Effect<void, Error, Requirements>,
    ) =>
      FiberMap.run(
        scheduled,
        task,
        Effect.sleep(intervalMs).pipe(Effect.andThen(action), Effect.forever),
      ).pipe(Effect.asVoid),
    delay: <Error, Requirements>(
      task: CoordinatorTask,
      delayMs: number,
      action: Effect.Effect<void, Error, Requirements>,
      options?: { readonly onlyIfMissing?: boolean },
    ) =>
      FiberMap.run(
        scheduled,
        task,
        Effect.sleep(delayMs).pipe(Effect.andThen(action)),
        options,
      ).pipe(Effect.asVoid),
    cancel: (task: CoordinatorTask) => FiberMap.remove(scheduled, task),
    clear: FiberMap.clear(scheduled),
    serialize: <Value, Error, Requirements>(operation: Effect.Effect<Value, Error, Requirements>) =>
      Semaphore.withPermit(operations)(operation),
  };
});

export type CoordinatorTasks = Effect.Success<typeof makeCoordinatorTasks>;
export const CoordinatorTasks = Context.Service<CoordinatorTasks>(
  'televecha/telegram/session/CoordinatorTasks',
);
export const CoordinatorTasksLayer = Layer.effect(CoordinatorTasks, makeCoordinatorTasks);
