import { expect, test } from '@playwright/test';

test('keeps chat navigation and details reachable on a phone', async ({ page }) => {
  await page.goto('/');
  const openChats = page.getByRole('button', { name: 'Open chat list' });
  await expect(openChats).toBeVisible();

  const sidebar = page.getByTestId('chat-sidebar');
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);
  await openChats.click();
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().left))
    .toBeGreaterThanOrEqual(0);
  await expect(sidebar).toHaveAttribute('role', 'dialog');
  await expect(sidebar).toBeFocused();
  await expect(page.locator('.conversation-pane')).toHaveAttribute('inert', '');

  await page.keyboard.press('Escape');
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);
  await expect(openChats).toBeFocused();
  await expect(page.locator('.conversation-pane')).not.toHaveAttribute('inert', '');

  await openChats.click();

  await sidebar.getByRole('button', { name: /Release Channel/ }).click();
  await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready');
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);

  await page.getByRole('button', { name: 'Open details' }).click();
  const details = page.locator('.details-pane');
  await expect(details).toBeVisible();
  await expect(details).toHaveAttribute('role', 'dialog');
  await expect(details).toBeFocused();
  await expect(page.locator('.conversation-pane')).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open details' })).toBeFocused();

  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBe(0);
});
