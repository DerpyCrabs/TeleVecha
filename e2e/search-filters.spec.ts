import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';

for (const width of [375, 768, 1280]) {
  test(`combines sender, media and date filters at ${width}px`, async ({ page }, testInfo) => {
    await openReady(page, '/?chat=g%3A303');
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => {
      const date = Math.floor(new Date(2026, 9, 12, 12).getTime() / 1000);
      const base = {
        peerId: 'g:303',
        senderId: 'u:404',
        senderName: 'Fixture Author',
        outgoing: false,
        date,
        media: {
          kind: 'photo' as const,
          name: 'search.jpg',
          mimeType: 'image/jpeg',
          size: 100,
          width: 100,
          height: 100,
        },
      };
      window.__televechaFixture!.setMessages([
        { ...base, id: 901, text: 'Filter audit correct' },
        { ...base, id: 902, text: 'Filter audit other sender', senderId: 'u:405' },
        { ...base, id: 903, text: 'Filter audit old date', date: date - 86400 * 3 },
        { ...base, id: 904, text: 'Filter audit text only', media: undefined },
      ]);
    });
    await page.getByRole('button', { name: 'Search messages', exact: true }).click();
    const search = page.locator('.search-panel');
    await search.getByRole('searchbox', { name: 'Message search query' }).fill('Filter audit');
    await search.getByRole('searchbox', { name: 'Message search query' }).press('Enter');
    await search.getByRole('button', { name: 'Photos', exact: true }).click();
    await search.getByRole('button', { name: 'From anyone', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Choose sender', exact: true })
      .getByRole('button', { name: /Fixture Author/ })
      .click();
    await search.getByLabel('Filter by date', { exact: true }).click();
    await search.getByLabel('From date', { exact: true }).fill('2026-10-12');
    await search.getByLabel('To date', { exact: true }).fill('2026-10-12');
    const results = search.locator('.search-results');
    await expect(results).toContainText('Filter audit correct');
    await expect(results).not.toContainText('Filter audit other sender');
    await expect(results).not.toContainText('Filter audit old date');
    await expect(results).not.toContainText('Filter audit text only');
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('search-filters.png'),
    });
    await search.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(results).toContainText('Filter audit other sender');
    await expect(results).toContainText('Filter audit old date');
    await expect(results).toContainText('Filter audit text only');
    await results.getByRole('button', { name: /Filter audit correct/ }).click();
    await expect(page.locator('article[data-message-id="901"]')).toBeInViewport();
    if (width <= 650) {
      await expect(search).toHaveCount(0);
    } else await expect(search).toBeVisible();
  });
}
