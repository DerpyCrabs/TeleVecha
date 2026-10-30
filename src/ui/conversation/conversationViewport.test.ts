import { describe, expect, it } from 'vitest';
import { firstReadingAnchor } from './conversationViewport';

describe('reading anchor lookup', () => {
  it('finds the first intersecting row, including exact boundaries and gaps', () => {
    const points = [{ bottom: 10 }, { bottom: 20 }, { bottom: 40 }];
    expect(firstReadingAnchor(points, 20, true)).toBe(1);
    expect(firstReadingAnchor(points, 21, true)).toBe(2);
    expect(firstReadingAnchor(points, 45, true)).toBe(3);
    expect(firstReadingAnchor([], 0, true)).toBe(0);
  });
  it('retains DOM priority when positions overlap or are not monotonic', () => {
    expect(firstReadingAnchor([{ bottom: 30 }, { bottom: 10 }, { bottom: 40 }], 25, false)).toBe(0);
  });
  it('bounds position reads logarithmically for long ordered histories', () => {
    let reads = 0;
    const points = Array.from({ length: 10_000 }, (_, index) => ({
      get bottom() {
        reads++;
        return index * 40;
      },
    }));
    expect(firstReadingAnchor(points, 200_001, true)).toBe(5001);
    expect(reads).toBeLessThanOrEqual(14);
  });
});
