import { Effect, Fiber, FiberMap, Option } from 'effect';

/** Owns keyed single-flight requests and cached values. */
export const makeResourceCache = Effect.fn('ResourceCache.make')(function* () {
  const fibers = yield* FiberMap.make<string, unknown, unknown>();
  const values = new Map<string, unknown>();
  const versions = new Map<string, number>();
  let epoch = 0;

  const version = (key: string) => versions.get(key) ?? 0;

  const load = <Value, Error, Requirements>(
    key: string,
    loader: () => Effect.Effect<Value, Error, Requirements>,
  ): Effect.Effect<Value, Error, Requirements> =>
    Effect.suspend(() => {
      const current = FiberMap.getUnsafe(fibers, key);
      if (Option.isSome(current)) {
        return Fiber.join(current.value) as Effect.Effect<Value, Error>;
      }

      return FiberMap.run(fibers, key, Effect.suspend(loader), { startImmediately: false }).pipe(
        Effect.flatMap(Fiber.join),
      );
    });

  const cached = <Value, Error, Requirements>(
    key: string,
    loader: () => Effect.Effect<Value, Error, Requirements>,
  ): Effect.Effect<Value, Error, Requirements> =>
    Effect.suspend(() => {
      if (values.has(key)) return Effect.succeed(values.get(key) as Value);
      const capturedEpoch = epoch;
      const capturedVersion = version(key);
      return load(key, loader).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            if (epoch === capturedEpoch && version(key) === capturedVersion) {
              values.set(key, value);
            }
          }),
        ),
      );
    });

  const forget = Effect.fn('ResourceCache.forget')(function* (key: string) {
    values.delete(key);
    versions.set(key, version(key) + 1);
    yield* FiberMap.remove(fibers, key);
  });

  const invalidate = Effect.fn('ResourceCache.invalidate')(function* (
    key: string,
    ...requestKeys: string[]
  ) {
    versions.set(key, version(key) + 1);
    yield* Effect.forEach(requestKeys, (requestKey) => FiberMap.remove(fibers, requestKey), {
      discard: true,
    });
  });

  const invalidatePrefix = Effect.fn('ResourceCache.invalidatePrefix')(function* (prefix: string) {
    for (const key of values.keys()) {
      if (key.startsWith(prefix)) values.delete(key);
    }
    for (const key of versions.keys()) {
      if (key.startsWith(prefix)) versions.set(key, version(key) + 1);
    }
    const keys = [...fibers].map(([key]) => key).filter((key) => key.startsWith(prefix));
    yield* Effect.forEach(keys, (key) => FiberMap.remove(fibers, key), { discard: true });
  });

  const clear = Effect.gen(function* () {
    epoch += 1;
    values.clear();
    versions.clear();
    yield* FiberMap.clear(fibers);
  });

  return {
    load,
    cached,
    pending: (key: string) => FiberMap.hasUnsafe(fibers, key),
    pendingValue: <Value>(key: string): Effect.Effect<Value | undefined> =>
      Effect.suspend(() => {
        const current = FiberMap.getUnsafe(fibers, key);
        return Option.isSome(current)
          ? (Fiber.join(current.value).pipe(
              Effect.map((value) => value as Value),
              Effect.orElseSucceed(() => undefined),
            ) as Effect.Effect<Value | undefined>)
          : Effect.succeed(undefined);
      }),
    pendingWithPrefix: (prefix: string) =>
      [...fibers].filter(([key]) => key.startsWith(prefix)).map(([, fiber]) => Fiber.join(fiber)),
    forget,
    version,
    invalidate,
    invalidatePrefix,
    clear,
  };
});

export type ResourceCache = Effect.Success<ReturnType<typeof makeResourceCache>>;
