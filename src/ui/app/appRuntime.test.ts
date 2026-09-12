import { Deferred, Effect, FiberSet } from 'effect';
import { expect, it } from 'vitest';
import { subscribeAtUi } from './appRuntime';

it('releases a subscription acquired after its UI owner has stopped', async () => {
  let released = false;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tasks = yield* FiberSet.make();
        const run = yield* FiberSet.runtime(tasks)();
        const ready = yield* Deferred.make<void>();
        const stop = subscribeAtUi(
          run,
          Deferred.await(ready).pipe(
            Effect.as(
              Effect.sync(() => {
                released = true;
              }),
            ),
          ),
        );
        stop();
        yield* Deferred.succeed(ready, undefined);
      }),
    ),
  );
  expect(released).toBe(true);
});
