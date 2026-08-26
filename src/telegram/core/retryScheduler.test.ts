import { afterEach, describe, expect, it, vi } from 'vitest';

import { RetryScheduler } from './retryScheduler';

describe('RetryScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('deduplicates schedules and backs off until an attempt succeeds', async () => {
    vi.useFakeTimers();
    const scheduler = new RetryScheduler(100, 250);
    const attempt = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    scheduler.schedule(attempt);
    scheduler.schedule(attempt);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(250);

    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('reset cancels pending work and restores the base delay', async () => {
    vi.useFakeTimers();
    const scheduler = new RetryScheduler(100, 1_000);
    const attempt = vi.fn().mockResolvedValue(false);

    scheduler.schedule(attempt);
    scheduler.reset();
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt).not.toHaveBeenCalled();

    scheduler.schedule(attempt);
    await vi.advanceTimersByTimeAsync(99);
    expect(attempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledOnce();
  });
});
