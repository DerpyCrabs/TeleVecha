import { Effect, PubSub, Stream } from 'effect';

export type ConnectionStateEvent = Readonly<{
  _: 'connectionState';
  state: 'connected' | 'disconnected';
}>;

export type SessionGapEvent = Readonly<{
  _: 'sessionGap';
  firstMessageId?: bigint | undefined;
  uniqueId?: bigint | undefined;
}>;

export type UpdateEvent = Readonly<{ _: 'update'; update: unknown }>;

export type MtprotoClientEvent = ConnectionStateEvent | SessionGapEvent | UpdateEvent;

export const connectionStateEvent = Object.assign(
  (state: ConnectionStateEvent['state']): ConnectionStateEvent =>
    Object.freeze({ _: 'connectionState' as const, state }),
  {
    is(value: unknown): value is ConnectionStateEvent {
      return (
        typeof value === 'object' &&
        value !== null &&
        (value as { _?: unknown })._ === 'connectionState'
      );
    },
  },
);

export const sessionGapEvent = Object.assign(
  (firstMessageId?: bigint, uniqueId?: bigint): SessionGapEvent =>
    Object.freeze({
      _: 'sessionGap' as const,
      ...(firstMessageId === undefined ? {} : { firstMessageId }),
      ...(uniqueId === undefined ? {} : { uniqueId }),
    }),
  {
    is(value: unknown): value is SessionGapEvent {
      return (
        typeof value === 'object' && value !== null && (value as { _?: unknown })._ === 'sessionGap'
      );
    },
  },
);

export const updateEvent = Object.assign(
  (update: unknown): UpdateEvent => Object.freeze({ _: 'update' as const, update }),
  {
    is(value: unknown): value is UpdateEvent {
      return (
        typeof value === 'object' && value !== null && (value as { _?: unknown })._ === 'update'
      );
    },
  },
);

/** The socket reader must keep dispatching RPC replies even if update consumers
 * are busy. Bound its update backlog, but make every dropped range observable. */
export const makeClientEventHub = (capacity = 256) =>
  Effect.gen(function* () {
    let sequence = 0;
    let connection: ConnectionStateEvent | undefined;
    const hub = yield* PubSub.sliding<{
      sequence: number;
      event: MtprotoClientEvent;
      connection: ConnectionStateEvent | undefined;
    }>(capacity);
    yield* Effect.addFinalizer(() => PubSub.shutdown(hub));
    return {
      publish: (event: MtprotoClientEvent) =>
        Effect.suspend(() => {
          if (connectionStateEvent.is(event)) connection = event;
          return PubSub.publish(hub, { sequence: ++sequence, event, connection });
        }),
      events: Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(hub);
          let previous = sequence;
          return Stream.fromSubscription(subscription).pipe(
            Stream.map((entry): readonly MtprotoClientEvent[] => {
              const missed = entry.sequence !== previous + 1;
              previous = entry.sequence;
              if (!missed) return [entry.event];
              return [
                sessionGapEvent(),
                ...(entry.connection && !connectionStateEvent.is(entry.event)
                  ? [entry.connection]
                  : []),
                entry.event,
              ];
            }),
            Stream.flattenIterable,
          );
        }),
      ),
    };
  });
