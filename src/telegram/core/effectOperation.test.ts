import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vitest';

import { withOperationDeadline } from './effectOperation';

describe('effectOperation', () => {
  it('interrupts the operation and exposes a typed deadline failure', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let interrupted = false;
        const operation = withOperationDeadline(
          'history',
          Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
          100,
          'History timed out.',
        );
        const fiber = yield* operation.pipe(Effect.result, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(100);
        const result = yield* Fiber.join(fiber);
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect(result.failure).toMatchObject({
            _tag: 'OperationDeadlineExceeded',
            operation: 'history',
            message: 'History timed out.',
            durationMs: 100,
          });
        }
        expect(interrupted).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
    ));
});
