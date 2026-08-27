import { describe, expect, it, vi } from 'vitest';

import type { PendingSend } from '../types';
import { PendingSendQueue } from './pendingQueue';

function pending(id: string, peerId = 'u:1') {
  return {
    id,
    peer: { id: peerId, kind: 'user' },
    createdAt: 1,
  } as PendingSend;
}

describe('PendingSendQueue coordination', () => {
  it('serializes deliveries for one peer while allowing another peer to proceed', async () => {
    const queue = new PendingSendQueue({ commitOutbox: vi.fn(async () => undefined) });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => void (releaseFirst = resolve));

    const first = queue.scheduleDelivery(pending('first'), async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    const second = queue.scheduleDelivery(pending('second'), async () => {
      events.push('second');
    });
    const otherPeer = queue.scheduleDelivery(pending('other', 'u:2'), async () => {
      events.push('other');
    });

    await otherPeer;
    expect(events).toEqual(['first:start', 'other']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'other', 'first:end', 'second']);
  });

  it('owns cancellation and peer blocking state', () => {
    const queue = new PendingSendQueue({ commitOutbox: vi.fn(async () => undefined) });
    queue.cancel('send');
    queue.block('u:1', 'send');

    expect(queue.isCancelled('send')).toBe(true);
    expect(queue.blockedBy('u:1')).toBe('send');
    expect(queue.releaseBlock('u:1', 'different')).toBe(false);
    expect(queue.releaseBlock('u:1', 'send')).toBe(true);

    queue.finishCancellation('send');
    expect(queue.isCancelled('send')).toBe(false);
  });
});
