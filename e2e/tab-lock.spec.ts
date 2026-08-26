import { expect, test } from '@playwright/test';

test('shares the active-tab lease between app instances in the same document', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-list')).toBeVisible();

  const acquired = await page.evaluate(async () => {
    const { acquireSingleTabLease } = await import('../src/telegram/session/tabLock');
    const first = await acquireSingleTabLease();
    const second = await acquireSingleTabLease();
    first?.release();
    second?.release();
    return Boolean(first && second);
  });

  expect(acquired).toBe(true);
  await expect(page.getByTestId('chat-list')).toBeVisible();
});

test('blocks a second tab, then allows retry after the first tab releases the lease', async ({
  context,
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-list')).toBeVisible();

  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('heading', { name: 'Connection failed' })).toBeVisible();
  await expect(second.getByText('TeleVecha is already open in another tab.')).toBeVisible();

  await page.close();
  await second.getByRole('button', { name: 'Retry' }).click();
  await expect(second.getByRole('dialog')).toHaveCount(0);
  await expect(second.getByTestId('chat-list')).toBeVisible();
});
