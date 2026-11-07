import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';

for (const width of [375, 768, 1280]) {
  test(`Mini Apps require consent and exchange events at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.route('**/e2e/mini-app.html*', (route) =>
      route.fulfill({ path: 'e2e/mini-app.html', contentType: 'text/html' }),
    );
    await openReady(page);
    await page.getByRole('textbox', { name: 'Search chats' }).fill('helper');
    await page.getByTestId('peer-search-result').filter({ hasText: 'Fixture Helper Bot' }).click();
    await page.getByRole('button', { name: 'Start bot', exact: true }).click();
    await page.setViewportSize({ width, height: 800 });
    const launch = page.getByRole('button', { name: 'Open Mini App', exact: true });
    await launch.click();
    const consent = page.getByRole('dialog', { name: /^Open .+\?$/ });
    await expect(consent).toContainText('public Telegram profile');
    await expect(page.locator('.mini-app-frame')).toHaveCount(0);
    await consent.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(consent).toHaveCount(0);
    await launch.click();
    await consent.getByRole('button', { name: 'Open', exact: true }).click();
    const dialog = page.locator('.mini-app-dialog');
    const frame = page.frameLocator('.mini-app-frame');
    await expect(frame.getByRole('heading', { name: 'Fixture Mini App' })).toBeVisible();
    await expect(frame.locator('#events')).toContainText('theme_changed');
    await expect(page.locator('.mini-app-frame')).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-forms',
    );
    await frame.getByRole('button', { name: 'Show main button' }).click();
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(frame.locator('#events')).toContainText('main_button_pressed');
    await frame.getByRole('button', { name: 'Show back button' }).click();
    await dialog.getByRole('button', { name: 'Back in Mini App' }).click();
    await expect(frame.locator('#events')).toContainText('back_button_pressed');
    const backBounds = await dialog.getByRole('button', { name: 'Back in Mini App' }).boundingBox();
    const frameBounds = await page.locator('.mini-app-frame').boundingBox();
    expect(backBounds!.y + backBounds!.height).toBeLessThanOrEqual(frameBounds!.y);
    await frame.getByRole('button', { name: 'Show popup' }).click();
    const popup = page.getByRole('dialog', { name: 'Fixture question' });
    await popup.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(frame.locator('#events')).toContainText('popup_closed');
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('mini-app.png') });
    await frame.getByRole('button', { name: 'Protect unsaved changes' }).click();
    await dialog.getByRole('button', { name: 'Close Mini App', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Close Mini App?', exact: true });
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeVisible();
    await frame.getByRole('button', { name: 'Send data twice' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.__televechaFixture!.stats.sendWebAppData)).toBe(1);
  });
}
