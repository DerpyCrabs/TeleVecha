import { Effect } from 'effect';

/** Use a locally cached value when present, otherwise run the load. */
export const cachedLoad = <A, E, R>(
  read: () => A | undefined,
  load: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const value = read();
    return value === undefined ? load() : Effect.succeed(value);
  });
