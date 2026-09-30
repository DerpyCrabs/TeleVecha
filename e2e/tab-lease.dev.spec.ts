import { test } from '@playwright/test';
import { expect } from './expect';

test('keeps one active-tab lease until its scoped release runs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-list')).toBeVisible();

  const acquired = await page.evaluate(async () => {
    const { acquireSingleTabLease } = await import('../src/telegram/session/tabLock');
    const runtime = window.__televechaRuntimes?.get('fixture:default');
    if (!runtime) return false;
    const first = await runtime.runEffect(acquireSingleTabLease());
    const second = await runtime.runEffect(acquireSingleTabLease());
    if (first) await runtime.runEffect(first.release);
    const third = await runtime.runEffect(acquireSingleTabLease());
    if (third) await runtime.runEffect(third.release);
    return Boolean(first && !second && third);
  });

  expect(acquired).toBe(true);
  await expect(page.getByTestId('chat-list')).toBeVisible();
});
