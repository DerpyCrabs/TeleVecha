import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';
for (const width of [1280, 375]) {
  test(`edits and searches saved tags at ${width}px`, async ({ page }, testInfo) => {
    await openReady(page);
    await page.setViewportSize({ width, height: 800 });
    if (width <= 650)
      await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
    await page.getByRole('button', { name: 'Open main menu' }).click();
    await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
    await page.getByRole('button', { name: /All messages Everything/ }).click();
    const history = page.getByTestId('message-scroller');
    await history.getByRole('button', { name: 'Edit tags for message 6001', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Message tags', exact: true });
    await expect(picker.getByRole('button', { name: '⭐ Ideas', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await picker.getByRole('button', { name: '👍', exact: true }).click();
    await page.screenshot({
      path: testInfo.outputPath(`saved-tags-picker-${width}.png`),
      animations: 'disabled',
    });
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await history.getByRole('button', { name: 'Search saved tag 👍', exact: true }).click();
    const search = page.locator('.search-panel');
    await expect(search.locator('.search-results')).toContainText('Saved from Alice');
    await expect(search.locator('.search-results')).not.toContainText('Saved release checklist');
    await search.getByRole('button', { name: 'Rename 👍 tag', exact: true }).click();
    const rename = page.getByRole('dialog', { name: 'Tag name', exact: true });
    await rename.getByRole('textbox', { name: 'Tag name', exact: true }).fill('Work');
    await rename.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(rename).toHaveCount(0);
    await expect(
      search.getByRole('button', { name: 'Rename Work tag', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`saved-tags-search-${width}.png`),
      animations: 'disabled',
    });
    if (width <= 650)
      await search.getByRole('button', { name: 'Close search', exact: true }).click();
    if (
      width <= 650 &&
      (await page.getByRole('complementary', { name: 'Saved chats' }).isVisible())
    )
      await page.getByRole('button', { name: /All messages Everything/ }).click();
    await history.getByRole('button', { name: 'Edit tags for message 6001', exact: true }).click();
    await picker.getByRole('button', { name: '👍 Work', exact: true }).click();
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      history.getByRole('button', { name: 'Search saved tag Work', exact: true }),
    ).toHaveCount(0);
    await expect(
      history.getByRole('button', { name: 'Search saved tag Ideas', exact: true }),
    ).toBeVisible();
    if (width > 650)
      await expect(search.locator('.search-results')).toContainText('No messages found');
  });
}

test('explains Premium requirement without offering a fake tag save', async ({ page }) => {
  await openReady(page, '/?scenario=saved-free');
  await page.getByRole('button', { name: 'Open main menu' }).click();
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await page.getByRole('button', { name: /All messages Everything/ }).click();
  await page.getByRole('button', { name: 'Edit tags for message 6001', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Message tags', exact: true });
  await expect(picker).toContainText('requires Telegram Premium');
  await expect(picker.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(picker.getByRole('button', { name: '⭐ Ideas', exact: true })).toBeDisabled();
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(picker).toHaveCount(0);
});

test('recognizes Saved Messages and named tags after opening a direct chat link', async ({
  page,
}) => {
  await openReady(page, '/?chat=u%3A900000001');
  const history = page.getByTestId('message-scroller');
  await expect(
    history.getByRole('button', { name: 'Edit tags for message 6001', exact: true }),
  ).toBeVisible();
  await expect(
    history.getByRole('button', { name: 'Search saved tag Ideas', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    history.getByRole('button', { name: 'Search saved tag Ideas', exact: true }),
  ).toBeVisible();
});
