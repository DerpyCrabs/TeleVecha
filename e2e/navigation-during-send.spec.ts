import { test } from '@playwright/test';
import { expect } from './expect';

import { chatButton, openReady, selectAlice } from './helpers';

test('switches dialogs while a media upload is still in progress', async ({ page }) => {
  await openReady(page, '/?scenario=held-upload&chat=u%3A101');
  await selectAlice(page);
  await page.locator('input[type="file"]').setInputFiles('e2e/fixtures/report.txt');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('25%')).toBeVisible();

  try {
    await chatButton(page, /Release Channel/).click();

    await expect(page).toHaveURL(/chat=c%3A202/u, { timeout: 1_000 });
    await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready', {
      timeout: 1_000,
    });
  } finally {
    await page.evaluate(() => window.__televechaFixture?.releaseUpload());
  }
});

test('updates the preview and switches dialogs while a text send is pending', async ({ page }) => {
  await test.step('updates the chat preview while a text message send is still in progress', async () => {
    await openReady(page, '/?scenario=held-send&chat=u%3A101');
    await selectAlice(page);
    await page.getByRole('textbox', { name: 'Message' }).fill('Pending preview text');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(
      page.locator('article.message', { hasText: 'Pending preview text' }),
    ).toBeVisible();

    try {
      await expect(chatButton(page, /Alice Fixture/)).toContainText('Pending preview text', {
        timeout: 1_000,
      });
    } finally {
      await page.evaluate(() => window.__televechaFixture?.releaseSend());
    }
  });
  await test.step('switches dialogs while a text message send is still in progress', async () => {
    await page.getByRole('textbox', { name: 'Message' }).fill('Pending text send');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('article.message', { hasText: 'Pending text send' })).toBeVisible();

    try {
      await chatButton(page, /Release Channel/).click();

      await expect(page).toHaveURL(/chat=c%3A202/u, { timeout: 1_000 });
      await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready', {
        timeout: 1_000,
      });
    } finally {
      await page.evaluate(() => window.__televechaFixture?.releaseSend());
    }
  });
});
