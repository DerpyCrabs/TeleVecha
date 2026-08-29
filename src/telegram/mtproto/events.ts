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

export type MtprotoEventListener = (event: MtprotoClientEvent) => void;

export interface MtprotoEventHub {
  emit(event: MtprotoClientEvent): void;
  subscribe(listener: MtprotoEventListener): () => void;
  clear(): void;
}

export function createMtprotoEventHub(): MtprotoEventHub {
  const listeners = new Set<MtprotoEventListener>();

  return {
    emit(event) {
      for (const listener of Array.from(listeners)) {
        try {
          listener(event);
        } catch {
          continue;
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    clear() {
      listeners.clear();
    },
  };
}
