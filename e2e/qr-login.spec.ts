import { test } from '@playwright/test';
import { expect } from './expect';

for (const width of [375, 1280]) {
  test(`QR login rotates its token and returns to phone entry at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?scenario=auth');
    await page.getByRole('button', { name: 'Log in by QR Code', exact: true }).click();
    const qr = page.getByRole('img', { name: 'Scan this QR code with Telegram on your phone' });
    await expect(qr).toBeVisible();
    await expect(page.locator('.auth-qr ol')).toHaveCSS('list-style-type', 'decimal');
    const first = await qr.evaluate((node) => (node as HTMLCanvasElement).toDataURL());
    await page.screenshot({ path: testInfo.outputPath('qr-login.png') });
    await expect
      .poll(() => qr.evaluate((node) => (node as HTMLCanvasElement).toDataURL()), { timeout: 8000 })
      .not.toBe(first);
    await page.getByRole('button', { name: 'Log in by phone number', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Phone', exact: true })).toBeVisible();
    await expect(qr).toHaveCount(0);
  });
}

for (const scenario of ['auth-qr-success', 'auth-qr-password']) {
  test(`completes ${scenario} through the QR screen`, async ({ page }) => {
    await page.goto(`/?scenario=${scenario}`);
    await page.getByRole('button', { name: 'Log in by QR Code', exact: true }).click();
    await expect(
      page.getByRole('img', { name: 'Scan this QR code with Telegram on your phone' }),
    ).toBeVisible();
    if (scenario === 'auth-qr-password') {
      await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible({
        timeout: 8000,
      });
      await page.getByLabel('Password', { exact: true }).fill('correct');
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    }
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 8000 });
    await expect(page.getByTestId('chat-list')).toBeVisible();
  });
}
