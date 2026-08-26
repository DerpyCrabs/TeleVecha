export class RetryScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;

  constructor(
    private readonly baseDelayMs: number,
    private readonly maxDelayMs: number,
  ) {}

  schedule(attempt: () => Promise<boolean>) {
    if (this.timer) return;
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.attempts);
    this.attempts += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void attempt().then((retry) => {
        if (retry) this.schedule(attempt);
      });
    }, delay);
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  reset() {
    this.cancel();
    this.attempts = 0;
  }
}
