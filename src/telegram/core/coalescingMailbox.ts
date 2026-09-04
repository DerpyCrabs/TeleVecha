import { Effect, Fiber, FiberMap } from 'effect';

interface CoalescingMailboxOptions<Value> {
  readonly merge: (previous: Value, incoming: Value) => Value;
  readonly onFailure?: (
    key: string,
    pending: Value,
    error: unknown,
  ) => Effect.Effect<void> | undefined;
}

/** Owns coalesced work and one scoped consumer fiber per key. */
export const makeCoalescingMailbox = Effect.fn('engine.coalescingMailbox.make')(function* <Value>(
  options: CoalescingMailboxOptions<Value>,
) {
  const pending = new Map<string, Value>();
  const consumers = yield* FiberMap.make<string, void, unknown>();

  const offer = (key: string, value: Value) =>
    Effect.sync(() => {
      const current = pending.get(key);
      pending.set(key, current === undefined ? value : options.merge(current, value));
    });

  const flush = (key: string, consume: (value: Value) => Effect.Effect<void, unknown>) =>
    Effect.gen(function* () {
      let drain: Effect.Effect<void, unknown>;
      drain = Effect.suspend((): Effect.Effect<void, unknown> => {
        const value = pending.get(key);
        if (value === undefined) return Effect.void;
        pending.delete(key);
        return consume(value).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const current = pending.get(key);
              pending.set(key, current === undefined ? value : options.merge(value, current));
              const failure = options.onFailure?.(key, pending.get(key)!, error);
              if (failure) yield* failure;
              return yield* Effect.fail(error);
            }),
          ),
          Effect.andThen(Effect.suspend(() => drain)),
        );
      });
      const fiber = yield* FiberMap.run(consumers, key, drain, { onlyIfMissing: true });
      yield* Fiber.join(fiber);
    });

  return {
    offer,
    flush,
    pending: (key: string) => pending.get(key),
    awaitEmpty: FiberMap.awaitEmpty(consumers),
    clear: Effect.all([FiberMap.clear(consumers), Effect.sync(() => pending.clear())], {
      discard: true,
    }),
  };
});

export type CoalescingMailbox<Value> = Effect.Success<
  ReturnType<typeof makeCoalescingMailbox<Value>>
>;
