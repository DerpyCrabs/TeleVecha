import { expect, test } from '@playwright/test';

import { fixtureStats, openReady, selectAlice } from './helpers';

test.beforeEach(async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
});

test('opens message actions from image content', async ({ page }) => {
  const image = page.getByRole('img', { name: 'fixture.jpg', exact: true });
  await expect(image).toBeVisible();

  const inlineAllowed = await image.evaluate((element) =>
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
  );
  expect(inlineAllowed).toBe(false);
  await expect(page.getByRole('menu', { name: 'Message actions' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Save media as' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Copy image' })).toBeVisible();
  await page.keyboard.press('Escape');

  await image.click();
  const preview = page.getByRole('dialog', { name: /Media preview:/ }).getByRole('img');
  await expect(preview).toBeVisible();
  const previewAllowed = await preview.evaluate((element) =>
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
  );
  expect(previewAllowed).toBe(false);
  await expect(page.getByRole('menu', { name: 'Media actions' })).toBeVisible();
});

test('copies regular and rich message text from the context menu', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  const regular = page.locator('article[data-message-id="80"]');
  await regular.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy text' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('Newest message from fixture');

  const rich = page.locator('article[data-message-id="74"]');
  await rich.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy text' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(
      [
        'Rich Markdown',
        'Highlighted and hidden',
        '- [x] Rendered task',
        'Feature\tStatus',
        'More\nNested content',
      ].join('\n\n'),
    );
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
