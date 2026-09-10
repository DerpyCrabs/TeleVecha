import { describe, expect, it } from 'vitest';

import { createMessageRevisions } from './messageRevisions';
import type { TelegramMessage } from '../types';

const message = (id: number, text: string = `message-${id}`): TelegramMessage => ({
  id,
  peerId: 'peer',
  senderId: 'sender',
  text,
  date: id,
  outgoing: false,
});

describe('message revisions', () => {
  it('rejects a fetched message changed after the request began', () => {
    const revisions = createMessageRevisions();
    const request = revisions.capture();
    revisions.record('peer', 2);

    expect(revisions.filter('peer', [message(1), message(2)], request).map(({ id }) => id)).toEqual(
      [1],
    );
    expect(
      revisions.merge('peer', [message(2, 'current')], [message(2, 'stale')], request),
    ).toEqual([message(2, 'current')]);
  });

  it('rejects an entire response older than the bounded mutation floor', () => {
    const revisions = createMessageRevisions(2);
    const request = revisions.capture();
    revisions.record('peer', 1);
    revisions.record('peer', 2);
    revisions.record('peer', 3);

    expect(revisions.filter('peer', [message(99)], request)).toEqual([]);
    expect(revisions.merge('peer', [message(5)], [message(99)], request)).toEqual([message(5)]);
  });

  it('clears remembered keys without moving the monotonic revision backward', () => {
    const revisions = createMessageRevisions(1);
    revisions.record('peer', 1);
    revisions.record('peer', 2);
    revisions.clear();
    const request = revisions.capture();

    expect(revisions.filter('peer', [message(1), message(2)], request)).toHaveLength(2);
  });
});
