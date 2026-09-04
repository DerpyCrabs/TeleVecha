import { describe, expect, test } from 'vitest';

import { retainPeerValue } from './retainedPeerValues';

describe('retainPeerValue', () => {
  test('keeps a peer value through an empty synchronization publication', () => {
    const counts = { photos: 128 };
    const committed = retainPeerValue(new Map(), 'u:101', counts);

    expect(retainPeerValue(committed, 'u:101', undefined)).toBe(committed);
    expect(committed.get('u:101')).toBe(counts);
  });

  test('does not erase or leak values when active peers transition', () => {
    const alice = { photos: 128 };
    const release = { photos: 17 };
    let values = retainPeerValue(new Map<string, typeof alice>(), 'u:101', alice);

    values = retainPeerValue(values, undefined, undefined);
    expect(values.get('u:101')).toBe(alice);
    expect(values.get('c:202')).toBeUndefined();

    values = retainPeerValue(values, 'c:202', release);
    expect(values.get('u:101')).toBe(alice);
    expect(values.get('c:202')).toBe(release);
  });

  test('publishes only a newly committed value', () => {
    const first = { photos: 128 };
    const changed = { photos: 129 };
    const committed = retainPeerValue(new Map(), 'u:101', first);

    expect(retainPeerValue(committed, 'u:101', first)).toBe(committed);
    expect(retainPeerValue(committed, 'u:101', changed)).not.toBe(committed);
  });
});
