import { Cause, Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { makeCoalescingMailbox } from './coalescingMailbox';

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

const maxMailbox = (
  onFailure?: (key: string, pending: number, error: unknown) => Effect.Effect<void, never, never>,
) => makeCoalescingMailbox({ merge: Math.max, ...(onFailure ? { onFailure } : {}) });

describe('coalescing mailbox', () => {
  it('coalesces offers and serializes values offered during a flush', () =>
    run(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const seen: number[] = [];
        const mailbox = yield* maxMailbox();
        yield* mailbox.offer('peer', 2);
        yield* mailbox.offer('peer', 5);
        const first = yield* mailbox
          .flush('peer', (value) =>
            Effect.gen(function* () {
              seen.push(value);
              if (seen.length === 1) yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* mailbox.offer('peer', 4);
        yield* mailbox.offer('peer', 8);
        const same = yield* mailbox.flush('peer', () => Effect.void).pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.all([Fiber.join(first), Fiber.join(same)]);
        expect(seen).toEqual([5, 8]);
        expect(mailbox.pending('peer')).toBeUndefined();
      }),
    ));

  it('retains failed work together with newer offers', () =>
    run(
      Effect.gen(function* () {
        const error = new Error('offline');
        const failures: Array<[string, number, unknown]> = [];
        const onFailure = vi.fn((key: string, pending: number, cause: unknown) =>
          Effect.sync(() => {
            failures.push([key, pending, cause]);
          }),
        );
        const mailbox = yield* maxMailbox(onFailure);
        yield* mailbox.offer('peer', 5);
        const failed = yield* mailbox
          .flush('peer', () => mailbox.offer('peer', 9).pipe(Effect.andThen(Effect.fail(error))))
          .pipe(Effect.result);
        expect(failed._tag).toBe('Failure');
        expect(mailbox.pending('peer')).toBe(9);
        expect(failures).toEqual([['peer', 9, error]]);
        const seen: number[] = [];
        yield* mailbox.flush('peer', (value) =>
          Effect.sync(() => {
            seen.push(value);
          }),
        );
        expect(seen).toEqual([9]);
      }),
    ));

  it('invalidates pending work and late failures on clear', () =>
    run(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const onFailure = vi.fn(() => Effect.void);
        const mailbox = yield* maxMailbox(onFailure);
        yield* mailbox.offer('old', 3);
        const old = yield* mailbox
          .flush('old', () =>
            Deferred.await(release).pipe(Effect.andThen(Effect.fail(new Error('late')))),
          )
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* mailbox.clear;
        yield* mailbox.offer('new', 7);
        yield* Deferred.succeed(release, undefined);
        const exit = yield* Fiber.await(old);
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(mailbox.pending('old')).toBeUndefined();
        expect(mailbox.pending('new')).toBe(7);
        expect(onFailure).not.toHaveBeenCalled();
      }),
    ));
});
