import { expect, test } from '@playwright/test';

import { chatButton, fixtureStats, openReady, selectAlice } from './helpers';

test('completes a normal interaction sequence without page errors or console errors', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await openReady(page);
  await selectAlice(page);
  await page.getByRole('textbox', { name: 'Search chats' }).fill('fixture');
  await page.getByRole('textbox', { name: 'Search chats' }).clear();
  await page.getByRole('button', { name: 'Groups' }).click();
  await page.getByRole('button', { name: 'All' }).click();
  await chatButton(page, /Release Channel/).click();
  await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready');
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('button', { name: 'Open details' }).click();
  await page.waitForTimeout(100);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('keeps cached messages readable through a live disconnect and reconnect', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  const composer = page.getByRole('textbox', { name: 'Message' });
  await expect(composer).toBeEnabled();

  await page.evaluate(() =>
    window.__televechaFixture?.emit({ type: 'connection-state', connected: false }),
  );

  const notice = page.getByRole('alert').filter({ hasText: /Offline.*connection was lost/i });
  await expect(notice).toBeVisible();
  await expect(page.getByTestId('message-scroller')).toContainText('Newest message from fixture');
  await composer.fill('Drafted while offline');
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();

  await notice.getByRole('button', { name: 'Retry' }).click();
  await expect(notice).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await expect.poll(async () => (await fixtureStats(page))?.connect ?? 0).toBeGreaterThanOrEqual(2);
});

test('reconnects automatically when focus returns after a background disconnect', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  const connectsBefore = (await fixtureStats(page))?.connect ?? 0;

  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    window.dispatchEvent(new Event('blur'));
    window.__televechaFixture?.emit({ type: 'connection-state', connected: false });
  });

  const notice = page.getByRole('alert').filter({ hasText: /Offline.*connection was lost/i });
  await expect(notice).toBeVisible();
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hasFocus');
    window.dispatchEvent(new Event('focus'));
  });

  await expect(notice).toHaveCount(0);
  await expect
    .poll(async () => (await fixtureStats(page))?.connect ?? 0)
    .toBeGreaterThan(connectsBefore);
});
