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

  const connectionChip = page.getByRole('button', { name: /Offline.*Retry Telegram connection/i });
  await expect(connectionChip).toBeVisible();
  const chipBox = await connectionChip.boundingBox();
  expect(chipBox?.height).toBeLessThan(32);
  await expect(page.getByTestId('message-scroller')).toContainText('Newest message from fixture');
  await composer.fill('Drafted while offline');
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('article.message', { hasText: 'Drafted while offline' })).toBeVisible();

  await connectionChip.click();
  await expect(connectionChip).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(
    page
      .locator('article.message', { hasText: 'Drafted while offline' })
      .locator('footer[aria-label*="Message status: sent"]'),
  ).toBeVisible();
  await expect.poll(async () => (await fixtureStats(page))?.connect ?? 0).toBeGreaterThanOrEqual(2);
});

test('waits for a live reconnect before loading newly revealed media', async ({ page }) => {
  await page.goto('/?scenario=held-connect');
  await expect(page.getByText('Connecting to Telegram')).toBeVisible();
  await page.evaluate(() => window.__televechaFixture?.releaseConnect());
  await selectAlice(page);

  await page.evaluate(() =>
    window.__televechaFixture?.emit({ type: 'connection-state', connected: false }),
  );
  await expect(
    page.getByRole('button', { name: /Offline.*Retry Telegram connection/i }),
  ).toBeVisible();
  const downloadsBefore = (await fixtureStats(page))?.downloadMedia ?? 0;
  await page.evaluate(() => {
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 91,
        peerId: 'u:101',
        senderId: 'u:101',
        text: '',
        date: 1_700_005_000,
        outgoing: false,
        media: {
          kind: 'photo',
          name: 'reconnect-photo.jpg',
          mimeType: 'image/jpeg',
          width: 640,
          height: 360,
        },
      },
    });
  });
  await expect(page.locator('article[data-message-id="91"]')).toBeVisible();

  await expect
    .poll(async () => (await fixtureStats(page))?.connect ?? 0, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('img', { name: 'reconnect-photo.jpg', exact: true })).toHaveCount(0);
  await expect(page.getByText(/media requested before connection was ready/i)).toHaveCount(0);

  await page.evaluate(() => window.__televechaFixture?.releaseConnect());
  await expect(page.getByRole('img', { name: 'reconnect-photo.jpg', exact: true })).toBeVisible();
  await expect(page.getByText(/media requested before connection was ready/i)).toHaveCount(0);
  expect((await fixtureStats(page))?.downloadMedia).toBeGreaterThan(downloadsBefore);
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

  const connectionChip = page.getByRole('button', {
    name: /Offline.*Retry Telegram connection/i,
  });
  await expect(connectionChip).toBeVisible();
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hasFocus');
    window.dispatchEvent(new Event('focus'));
  });

  await expect(connectionChip).toHaveCount(0);
  await expect
    .poll(async () => (await fixtureStats(page))?.connect ?? 0)
    .toBeGreaterThan(connectsBefore);
});

test('reconnects automatically while the tab remains focused', async ({ page }) => {
  await openReady(page);
  const connectsBefore = (await fixtureStats(page))?.connect ?? 0;

  await page.evaluate(() =>
    window.__televechaFixture?.emit({ type: 'connection-state', connected: false }),
  );

  await expect
    .poll(async () => (await fixtureStats(page))?.connect ?? 0, { timeout: 5_000 })
    .toBeGreaterThan(connectsBefore);
  await expect(page.getByText(/Offline.*connection was lost/i)).toHaveCount(0);
});
