import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';
for (const width of [1280, 375]) {
  test(`browses saved messages by source at ${width}px`, async ({ page }, testInfo) => {
    await openReady(page);
    await page.setViewportSize({ width, height: 800 });
    if (width <= 650)
      await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
    await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
    const sources = page.getByRole('complementary', { name: 'Saved chats' });
    await expect(
      sources.getByRole('button', { name: /Alice Fixture Saved from Alice/ }),
    ).toBeVisible();
    await sources.getByRole('button', { name: 'Pin Alice Fixture', exact: true }).click();
    await expect(
      sources.getByRole('button', { name: 'Unpin Alice Fixture', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`saved-sources-${width}.png`),
      animations: 'disabled',
    });
    await sources.getByRole('button', { name: /Alice Fixture Saved from Alice/ }).click();
    const history = page.getByTestId('message-scroller');
    await expect(history).toContainText('Saved from Alice');
    await expect(history).not.toContainText('Saved release checklist');
    await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');
    await expect(page).toHaveURL(/saved=u%3A101/);
    await page.reload();
    await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');
    await expect(history).toContainText('Saved from Alice');
    await expect(history).not.toContainText('Saved release checklist');
    if (width > 650) {
      await page.getByRole('button', { name: 'Search messages', exact: true }).click();
      const search = page.locator('.search-panel');
      await search.getByRole('searchbox', { name: 'Message search query' }).fill('Saved');
      await search.getByRole('searchbox', { name: 'Message search query' }).press('Enter');
      await expect(search.locator('.search-results')).toContainText('Saved from Alice');
      await expect(search.locator('.search-results')).not.toContainText('Saved release checklist');
      await search.getByRole('button', { name: 'Close search', exact: true }).click();
    }

    await expect(
      page.getByRole('button', { name: 'Write in Saved Messages', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`saved-history-${width}.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Show saved chats', exact: true }).click();
    await sources.getByRole('button', { name: /Release Channel Saved release checklist/ }).click();
    await expect(history).toContainText('Saved release checklist');
    await expect(history).not.toContainText('Saved from Alice');
    await page.getByRole('button', { name: 'Show saved chats', exact: true }).click();
    await sources.getByRole('button', { name: /My Notes My personal note/ }).click();
    await expect(history).toContainText('My personal note');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A new personal note');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(history).toContainText('A new personal note');
    await page.getByRole('button', { name: 'Show saved chats', exact: true }).click();
    await sources.getByRole('button', { name: /All messages/ }).click();
    await expect(history).toContainText('Saved from Alice');
    await expect(history).toContainText('Saved release checklist');
    await expect(history).toContainText('A new personal note');
  });
}
