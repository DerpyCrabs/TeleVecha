import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, chatButton } from './helpers';
for (const width of [1280, 375]) {
  test(`reads and filters recent actions at ${width}px`, async ({ page }, testInfo) => {
    await openReady(page, '/?scenario=forums');
    await page.setViewportSize({ width, height: 800 });
    if (width <= 650)
      await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
    await chatButton(page, /Release Channel/).click();
    await page
      .getByRole('complementary', { name: 'Forum topics' })
      .getByRole('button', { name: /^General/ })
      .click();
    if (await page.getByRole('button', { name: 'Open details', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Open details', exact: true }).click();
    await page.getByRole('button', { name: 'Manage group', exact: true }).click();
    await page.getByRole('button', { name: 'Recent actions', exact: true }).click();
    const log = page.getByRole('dialog', { name: 'Recent actions', exact: true });
    await expect(log.getByTestId('admin-log-event')).toHaveCount(1);
    await log.getByText('Details', { exact: true }).click();
    await expect(log).toContainText('Old team');
    await log.getByRole('button', { name: 'Earlier actions', exact: true }).click();
    await expect(log.getByTestId('admin-log-event')).toHaveCount(2);
    await log.getByRole('button', { name: 'Filter actions', exact: true }).click();
    await log.getByRole('combobox', { name: 'Action type', exact: true }).selectOption('messages');
    await expect(log.getByTestId('admin-log-event')).toHaveCount(1);
    await expect(log).toContainText('deleted a message');
    await log
      .getByRole('combobox', { name: 'Author', exact: true })
      .selectOption({ label: 'Alex Admin' });
    await expect(log).toContainText('No recent actions found');
    await log.getByRole('combobox', { name: 'Author', exact: true }).selectOption('');
    await expect(log.getByTestId('admin-log-event')).toHaveCount(1);
    await log.getByText('Details', { exact: true }).click();
    await expect(log).toContainText('Removed message text');
    await page.screenshot({
      path: testInfo.outputPath(`recent-actions-${width}.png`),
      animations: 'disabled',
    });
    await log.getByRole('textbox', { name: 'Search recent actions' }).fill('not found');
    await expect(log).toContainText('No recent actions found');
    await log.getByRole('textbox', { name: 'Search recent actions' }).fill('');
    await expect(log.getByTestId('admin-log-event')).toHaveCount(1);
    await log.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Manage group', exact: true })).toBeVisible();
  });
}
