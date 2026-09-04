import { Clock, Deferred, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vitest';

import { EngineTasks, EngineTasksLayer } from './engineTasks';

const run = <Value>(effect: Effect.Effect<Value, never, EngineTasks>) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provide(EngineTasksLayer), Effect.provide(TestClock.layer())),
  );

describe('EngineTasks', () => {
  it('drains tracked lifecycle work', async () => {
    await run(
      EngineTasks.use((tasks) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const tracked = yield* tasks.runSession(Deferred.await(gate)).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const draining = yield* tasks.drain.pipe(Effect.as('drained'), Effect.forkChild);
          yield* Effect.yieldNow;
          expect(draining.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(tracked);
          expect(yield* Fiber.join(draining)).toBe('drained');
        }),
      ),
    );
  });

  it('returns task failures without poisoning later work', async () => {
    const failure = new Error('task failed');
    const result = await run(
      EngineTasks.use((tasks) =>
        Effect.gen(function* () {
          const failed = yield* Effect.result(tasks.runSession(Effect.fail(failure)));
          const recovered = yield* tasks.runSession(Effect.succeed(42));
          return { failed, recovered };
        }),
      ),
    );

    expect(result.failed._tag).toBe('Failure');
    expect(result.recovered).toBe(42);
  });

  it('interrupts background work and accepts fresh work afterward', async () => {
    let interrupted = false;
    let freshWorkRan = false;
    await run(
      EngineTasks.use((tasks) =>
        Effect.gen(function* () {
          yield* tasks.forkBackground(
            Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ),
          );
          yield* tasks.interruptBackground;
          yield* tasks.forkBackground(
            Effect.sync(() => {
              freshWorkRan = true;
            }),
          );
          yield* Effect.yieldNow;
        }),
      ),
    );

    expect(interrupted).toBe(true);
    expect(freshWorkRan).toBe(true);
  });

  it('interrupts network work and accepts fresh network work afterward', async () => {
    let interrupted = false;
    const value = await run(
      EngineTasks.use((tasks) =>
        Effect.gen(function* () {
          const running = yield* tasks
            .runNetwork(
              Effect.never.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              ),
            )
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* tasks.interruptNetwork;
          const result = yield* Fiber.await(running);
          const fresh = yield* tasks.runNetwork(Effect.succeed(42));
          return { result, fresh };
        }),
      ),
    );

    expect(interrupted).toBe(true);
    expect(value.result._tag).toBe('Failure');
    expect(value.fresh).toBe(42);
  });

  it('replaces keyed delays and keeps delay slots independent', async () => {
    const events: string[] = [];
    await run(
      EngineTasks.use((tasks) =>
        Effect.gen(function* () {
          yield* tasks.delay(
            'activity',
            'peer',
            100,
            Effect.sync(() => events.push('old')),
          );
          yield* TestClock.adjust('50 millis');
          yield* tasks.delay(
            'activity',
            'peer',
            100,
            Effect.sync(() => events.push('replacement')),
          );
          yield* tasks.delay(
            'inboxRead',
            'peer',
            50,
            Effect.sync(() => events.push('read')),
          );
          yield* TestClock.adjust('50 millis');
          expect(events).toEqual(['read']);
          yield* TestClock.adjust('50 millis');
          expect(events).toEqual(['read', 'replacement']);
          expect(yield* tasks.hasDelay('activity', 'peer')).toBe(false);
        }),
      ),
    );
  });

  it('keeps the first requested delay and remains reusable after clearing', async () => {
    const events: string[] = [];
    await run(
      EngineTasks.use((tasks) =>
        Effect.gen(function* () {
          yield* tasks.delay(
            'inboxRead',
            'peer',
            100,
            Effect.sync(() => events.push('first')),
            { onlyIfMissing: true },
          );
          yield* tasks.delay(
            'inboxRead',
            'peer',
            100,
            Effect.sync(() => events.push('duplicate')),
            { onlyIfMissing: true },
          );
          yield* tasks.clearDelays('inboxRead');
          yield* TestClock.adjust('100 millis');
          expect(events).toEqual([]);
          yield* tasks.delay(
            'inboxRead',
            'peer',
            10,
            Effect.sync(() => events.push('fresh')),
          );
          yield* TestClock.adjust('10 millis');
          expect(events).toEqual(['fresh']);
        }),
      ),
    );
  });

  it('deduplicates and cancels the reconnect retry', async () => {
    const attempts: string[] = [];
    await run(
      EngineTasks.use((tasks) =>
        Effect.gen(function* () {
          const reconnect = Effect.sync(() => {
            attempts.push('reconnect');
            return false;
          });
          yield* tasks.retry('reconnect', reconnect);
          yield* tasks.retry('reconnect', reconnect);
          yield* tasks.cancelRetry('reconnect');
          yield* TestClock.adjust(1_000);
          expect(attempts).toEqual([]);

          yield* tasks.retry('reconnect', reconnect);
          yield* TestClock.adjust(1_000);
          yield* Effect.yieldNow;
        }),
      ),
    );

    expect(attempts).toEqual(['reconnect']);
  });

  it('backs retries off exponentially and caps the delay', async () => {
    const attempts: number[] = [];
    await run(
      EngineTasks.use((tasks) =>
        Effect.gen(function* () {
          yield* tasks.retry(
            'reconnect',
            Effect.gen(function* () {
              attempts.push(yield* Clock.currentTimeMillis);
              return attempts.length < 7;
            }),
          );
          for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
            yield* TestClock.adjust(delay);
            yield* Effect.yieldNow;
          }
        }),
      ),
    );

    expect(attempts).toEqual([1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000]);
  });

  it('serializes work by lane and key while unrelated keys proceed', async () => {
    const events: string[] = [];
    await run(
      EngineTasks.use((tasks) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const first = yield* tasks
            .serialize(
              'mutation',
              'peer-1',
              Effect.gen(function* () {
                events.push('first:start');
                yield* Deferred.await(gate);
                events.push('first:end');
              }),
            )
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const second = yield* tasks
            .serialize(
              'mutation',
              'peer-1',
              Effect.sync(() => events.push('second')),
            )
            .pipe(Effect.forkChild);
          const other = yield* tasks
            .serialize(
              'mutation',
              'peer-2',
              Effect.sync(() => events.push('other')),
            )
            .pipe(Effect.forkChild);
          yield* Fiber.join(other);
          expect(events).toEqual(['first:start', 'other']);
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          expect(events).toEqual(['first:start', 'other', 'first:end', 'second']);
        }),
      ),
    );
  });

  it('drains serialized work and remains usable after failure', async () => {
    const failure = new Error('failed');
    await run(
      EngineTasks.use((tasks) =>
        Effect.gen(function* () {
          const failed = yield* Effect.result(tasks.serialize('update', '', Effect.fail(failure)));
          expect(failed._tag).toBe('Failure');
          expect(yield* tasks.serialize('update', '', Effect.succeed(42))).toBe(42);
          yield* tasks.drainSerial(['update']);
        }),
      ),
    );
  });
  it('cancels caller-owned network work when its caller is interrupted', () =>
    run(
      EngineTasks.use((tasks) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          let finalized = false;
          const caller = yield* tasks
            .runNetwork(
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    finalized = true;
                  }),
                ),
              ),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(caller);
          expect(finalized).toBe(true);
        }),
      ),
    ));

  it('finishes accepted session writes after their caller leaves', () =>
    run(
      EngineTasks.use((tasks) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let committed = false;
          const caller = yield* tasks
            .runSession(
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                committed = true;
              }),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(caller);
          yield* Deferred.succeed(release, undefined);
          yield* tasks.drain;
          expect(committed).toBe(true);
        }),
      ),
    ));
});
