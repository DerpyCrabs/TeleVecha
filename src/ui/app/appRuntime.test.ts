import { describe, expect, it } from 'vitest';

import type { ReproTimelineEventV1 } from '../../debug/reproFormat';
import { replayActionAfterSequence } from './appRuntime';

describe('replay UI scheduling', () => {
  it('runs a chat selection immediately before its first recorded peer request', () => {
    const timeline: ReproTimelineEventV1[] = [
      { seq: 5, tMs: 0, kind: 'resolve', callId: 'auth' },
      { seq: 7, tMs: 1, kind: 'ui', method: 'select-chat', value: { peerId: 'c:1' } },
      { seq: 10, tMs: 2, kind: 'call', callId: 'difference', method: 'getDifference', args: [] },
      { seq: 11, tMs: 3, kind: 'resolve', callId: 'difference' },
      {
        seq: 14,
        tMs: 4,
        kind: 'call',
        callId: 'history',
        method: 'getHistory',
        args: [{ id: 'u:1', kind: 'user' }],
      },
      { seq: 19, tMs: 5, kind: 'resolve', callId: 'history' },
      {
        seq: 20,
        tMs: 6,
        kind: 'call',
        callId: 'counts',
        method: 'getSharedMediaCounts',
        args: [{ id: 'c:1', kind: 'channel' }],
      },
    ];

    expect(replayActionAfterSequence(timeline, 1, 'c:1')).toBe(19);
  });
});
