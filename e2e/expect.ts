import { expect as base } from '@playwright/test';

// Playwright polls at 100, 250, 500 and then every 1000 ms, so a condition that becomes true
// just after a check is noticed hundreds of milliseconds late. These conditions are cheap
// page reads; checking them often costs nothing and removes that idle time from every test.
const intervals = [10, 20, 50];

export const expect: typeof base = new Proxy(base, {
  get(target, key, receiver) {
    if (key === 'poll')
      return (actual: () => unknown, options?: string | { intervals?: number[] }) =>
        target.poll(
          actual,
          typeof options === 'string' ? { message: options, intervals } : { intervals, ...options },
        );
    return Reflect.get(target, key, receiver) as unknown;
  },
});
