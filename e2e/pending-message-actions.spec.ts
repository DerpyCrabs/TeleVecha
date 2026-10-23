import { test } from '@playwright/test';
import { expect } from './expect';
import { fixtureStats, openReady } from './helpers';

test('sending text has no inline actions and can be deleted from its context menu', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openReady(page, '/?scenario=held-send&chat=u%3A101');
  await page.getByRole('textbox', { name: 'Message' }).fill('Pending text regression');
  await page.getByRole('button', { name: 'Send message' }).click();
  const message = page.locator('article.message', { hasText: 'Pending text regression' });
  await expect(message).toBeVisible();
  await expect(message.locator('.pending-message-actions')).toHaveCount(0);
  await expect(message.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await message.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Delete']);
  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(message).toHaveCount(0);
  await page.evaluate(() => window.__televechaFixture?.releaseSend());
  await expect(message).toHaveCount(0);
  expect((await fixtureStats(page))?.deleteMessages).toBe(0);
  await page.reload();
  await expect(page.getByTestId('chat-list')).toBeVisible();
  await expect(message).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const { retry, count } of [
  { retry: false, count: 1 },
  { retry: true, count: 1 },
  { retry: false, count: 2 },
]) {
  test(`deletes an ${retry ? 'actively retrying failed' : 'uploading'} photo (${count} attachments) through its image context menu`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openReady(page, '/?chat=u%3A101');
    if (!retry) await page.evaluate(() => window.__televechaFixture?.holdNextUpload());
    await page
      .locator('input[type="file"]')
      .setInputFiles(Array.from({ length: count }, () => 'e2e/fixtures/outgoing-media.png'));
    const caption = retry ? 'FAIL' : 'Pending photo regression';
    await page.getByRole('textbox', { name: 'Message' }).fill(caption);
    await page.getByRole('button', { name: 'Send message' }).click();
    const message = page.locator('article.message', { hasText: caption });
    if (retry) {
      await expect(message.getByLabel('Failed message actions')).toBeVisible();
      await expect(message.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
      await page.evaluate(() => window.__televechaFixture?.holdNextUpload());
      await message.getByRole('button', { name: 'Retry', exact: true }).click();
    }
    await expect(message.locator('.media-upload-status').first()).toBeVisible();
    await expect(message.locator('.pending-message-actions')).toHaveCount(0);
    await message.locator('img').last().click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Message actions' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Delete']);
    await menu.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(message).toHaveCount(0);
    await page.evaluate(() => window.__televechaFixture?.releaseUpload());
    expect((await fixtureStats(page))?.deleteMessages).toBe(0);
    await page.reload();
    await expect(page.getByTestId('chat-list')).toBeVisible();
    await expect(message).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Message' }).fill('Send after deletion');
    await page.getByRole('button', { name: 'Send message' }).click();
    const next = page.locator('article.message', { hasText: 'Send after deletion' });
    await expect(next.locator('footer')).toHaveAttribute('aria-label', /Message status: sent$/u);
    await expect(next.locator('.pending-message-actions')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
