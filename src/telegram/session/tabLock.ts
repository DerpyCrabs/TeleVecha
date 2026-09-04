import { Effect, Schedule, Schema } from 'effect';

export class TabLockUnsupportedError extends Schema.TaggedError<TabLockUnsupportedError>()(
  'TabLockUnsupportedError',
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const tabLockUnsupported = (cause?: unknown): TabLockUnsupportedError => {
  const detail = cause instanceof Error ? ` ${cause.message}` : '';
  return new TabLockUnsupportedError({
    message: `This browser cannot provide the locking required for safe single-tab sync.${detail}`,
    ...(cause === undefined ? {} : { cause }),
  });
};

export interface TabLease {
  readonly release: Effect.Effect<void>;
}

export const acquireAvailableTabLease = (name: string) =>
  Effect.callback<TabLease | undefined, TabLockUnsupportedError>((resume) => {
    let released = false;
    let releaseLock: (() => void) | undefined;
    const request = navigator.locks.request(
      name,
      { ifAvailable: true, mode: 'exclusive' },
      (lock) => {
        if (!lock) {
          resume(Effect.succeed(undefined));
          return;
        }
        resume(
          Effect.succeed({
            release: Effect.sync(() => {
              if (released) return;
              released = true;
              releaseLock?.();
            }),
          }),
        );
        // Navigator Locks owns this Promise contract. Effect owns when it is resolved.
        return new Promise<void>((resolve) => {
          releaseLock = resolve;
          if (released) resolve();
        });
      },
    );
    void request.catch((cause: unknown) => resume(Effect.fail(tabLockUnsupported(cause))));
    return Effect.sync(() => {
      released = true;
      releaseLock?.();
    });
  });

export const acquireSingleTabLease = Effect.fn('TabLock.acquire')(function* () {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { release: Effect.void } satisfies TabLease;
  }
  if (!navigator.locks) return yield* Effect.fail(tabLockUnsupported());
  return yield* acquireAvailableTabLease('televecha-active-tab').pipe(
    Effect.repeat({
      while: (lease) => lease === undefined,
      schedule: Schedule.spaced(100).pipe(Schedule.upTo({ times: 1 })),
    }),
  );
});

export const isTabLockUnsupportedError = (error: unknown): error is TabLockUnsupportedError =>
  Schema.is(TabLockUnsupportedError)(error);
