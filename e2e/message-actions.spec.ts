import { expect, test } from '@playwright/test';

import { fixtureStats, openReady, selectAlice } from './helpers';

test.beforeEach(async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
});

test('pins and unpins a message and exposes the pinned-message bar', async ({ page }) => {
  const message = page.locator('article[data-message-id="79"]');
  await message.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /Pinned message.*Fixture message 79/ }),
  ).toBeVisible();
  await message.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();
  await expect(page.getByRole('button', { name: /Pinned message/ })).toHaveCount(0);
  expect((await fixtureStats(page))?.setPinnedMessage).toBe(2);
});

test('offers delete-for-me separately from revoke-for-everyone', async ({ page }) => {
  const message = page.locator('article[data-message-id="80"]');
  await message.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete message' });
  await expect(dialog.getByRole('button', { name: 'Delete for me' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete for everyone' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete for me' }).click();
  await expect(message).toHaveCount(0);
  expect((await fixtureStats(page))?.deleteMessages).toBe(1);
});
