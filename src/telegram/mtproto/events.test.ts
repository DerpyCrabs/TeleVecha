import { Deferred, Effect, Fiber, Stream } from 'effect';
import { describe, expect, it } from 'vitest';

import {
  connectionStateEvent,
  makeClientEventHub,
  sessionGapEvent,
  updateEvent,
  type MtprotoClientEvent,
} from './events';

describe('MTProto client events', () => {
  it('provides stable tagged factories and guards', () => {
    const connected = connectionStateEvent('connected');
    const gap = sessionGapEvent(10n, 20n);
    const update = updateEvent({ _: 'updateNewMessage' });

    expect(connectionStateEvent.is(connected)).toBe(true);
    expect(sessionGapEvent.is(gap)).toBe(true);
    expect(updateEvent.is(update)).toBe(true);
    expect(gap).toEqual({ _: 'sessionGap', firstMessageId: 10n, uniqueId: 20n });
    expect(Object.isFrozen(connected)).toBe(true);
  });
  it('reports overflow and preserves a dropped connection state without blocking the socket reader', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hub = yield* makeClientEventHub(2);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const received: MtprotoClientEvent[] = [];
          const reader = yield* hub.events.pipe(
            Stream.take(5),
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                received.push(event);
                if (received.length === 1) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
              }),
            ),
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* hub.publish(updateEvent(0));
          yield* Deferred.await(entered);
          yield* hub.publish(connectionStateEvent('disconnected'));
          for (let i = 1; i <= 3; i += 1) yield* hub.publish(updateEvent(i));
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(reader);
          expect(received).toEqual([
            updateEvent(0),
            sessionGapEvent(),
            connectionStateEvent('disconnected'),
            updateEvent(2),
            updateEvent(3),
          ]);
        }),
      ),
    ));

  it('does not report an old gap to a newly attached consumer', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hub = yield* makeClientEventHub(2);
          yield* hub.publish(updateEvent('before subscription'));
          const reader = yield* hub.events.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* hub.publish(updateEvent('current'));
          expect(yield* Fiber.join(reader)).toEqual([updateEvent('current')]);
        }),
      ),
    ));
});
