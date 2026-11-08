import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, chatButton } from './helpers';

for (const width of [1280, 375]) {
  test(`reviews individual join requests at ${width}px`, async ({ page }, testInfo) => {
    await openReady(page);
    await page.setViewportSize({ width, height: 800 });
    if (width <= 650)
      await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
    await chatButton(page, /Fixture Group/).click();
    if (await page.getByRole('button', { name: 'Open details', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Open details', exact: true }).click();
    await page.getByRole('button', { name: 'Manage group', exact: true }).click();
    await page.getByRole('button', { name: 'Join requests', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Join requests', exact: true });
    await expect(dialog).toContainText('2 pending requests');
    await page.screenshot({
      path: testInfo.outputPath(`requests-${width}.png`),
      animations: 'disabled',
    });
    const search = dialog.getByRole('textbox', { name: 'Search requests', exact: true });
    await search.fill('Nina');
    await expect(dialog.getByRole('article', { name: 'Alex Request', exact: true })).toHaveCount(0);
    await expect(dialog).toContainText('1 pending request');
    await dialog
      .getByRole('article', { name: 'Nina Request', exact: true })
      .getByRole('button', { name: 'Approve', exact: true })
      .click();
    await expect(dialog).toContainText('No matching requests');
    await search.fill('');
    await dialog
      .getByRole('article', { name: 'Alex Request', exact: true })
      .getByRole('button', { name: 'Dismiss', exact: true })
      .click();
    await expect(dialog).toContainText('No pending requests');
    await expect(dialog).toContainText('0 pending requests');
  });
}

test('confirms a bulk decision and allows cancelling it', async ({ page }) => {
  await openReady(page);
  await chatButton(page, /Fixture Group/).click();
  await page.getByRole('button', { name: 'Manage group', exact: true }).click();
  await page.getByRole('button', { name: 'Join requests', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Join requests', exact: true });
  await dialog.getByRole('button', { name: 'Dismiss all', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Dismiss all requests?', exact: true });
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByRole('article')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Approve all', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Approve all requests?', exact: true })
    .getByRole('button', { name: 'Approve all', exact: true })
    .click();
  await expect(dialog).toContainText('No pending requests');
});
