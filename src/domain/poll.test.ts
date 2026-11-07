import { describe, expect, it } from 'vitest';
import { mergePollResults, pollOptionBytes, pollOptionKey } from './poll';

describe('poll results', () => {
  it('preserves opaque option bytes including zero and high bytes', () => {
    const bytes = new Uint8Array([0, 128, 255, 1]);
    expect(pollOptionBytes(pollOptionKey(bytes))).toEqual(bytes);
    expect(() => pollOptionBytes('01no')).toThrow();
  });
  it('keeps personal choices and quiz answers when Telegram sends minimal results', () => {
    const previous = {
      totalVoters: 2,
      solution: 'Explanation',
      answers: [{ option: '00', voters: 1, chosen: true, correct: true }],
    };
    expect(
      mergePollResults(previous, {
        min: true,
        totalVoters: 3,
        answers: [{ option: '00', voters: 2, chosen: false, correct: false }],
      }),
    ).toMatchObject({
      totalVoters: 3,
      solution: 'Explanation',
      answers: [{ voters: 2, chosen: true, correct: true }],
    });
    expect(
      mergePollResults(previous, {
        min: false,
        totalVoters: 1,
        answers: [{ option: '00', voters: 0, chosen: false, correct: false }],
      }).answers?.[0]?.chosen,
    ).toBe(false);
  });
});
