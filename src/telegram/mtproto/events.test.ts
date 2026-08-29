import { describe, expect, it, vi } from 'vitest';

import {
  connectionStateEvent,
  createMtprotoEventHub,
  sessionGapEvent,
  updateEvent,
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

  it('keeps listener ownership local to the hub', () => {
    const hub = createMtprotoEventHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe(listener);
    hub.emit(connectionStateEvent('connected'));
    unsubscribe();
    unsubscribe();
    hub.emit(connectionStateEvent('disconnected'));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('isolates transport state from a failing event subscriber', () => {
    const hub = createMtprotoEventHub();
    const healthy = vi.fn();
    hub.subscribe(() => {
      throw new Error('subscriber failed');
    });
    hub.subscribe(healthy);

    expect(() => hub.emit(connectionStateEvent('connected'))).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(connectionStateEvent('connected'));
  });
});
