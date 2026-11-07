import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';

for (const width of [375, 768, 1280]) {
  test(`sticker hold preview, favorites and pack management work at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openReady(page, '/?chat=u%3A101');
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' }).click();
    const picker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
    await picker.getByRole('button', { name: 'Stickers', exact: true }).click();
    const sticker = picker.locator('.sticker-option').first();
    await expect(sticker).toBeVisible();
    const before = await page.evaluate(() => window.__televechaFixture!.stats.sendSticker);
    await sticker.hover();
    await page.mouse.down();
    await expect(page.locator('.sticker-hold-preview')).toBeVisible();
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('sticker-hold.png'),
    });
    await page.mouse.up();
    await expect(page.locator('.sticker-hold-preview')).toHaveCount(0);
    expect(await page.evaluate(() => window.__televechaFixture!.stats.sendSticker)).toBe(before);
    await sticker.click({ button: 'right' });
    const preview = page.getByRole('dialog', { name: 'Sticker preview', exact: true });
    await preview.getByRole('button', { name: 'Add to favorites', exact: true }).click();
    await expect(
      preview.getByRole('button', { name: 'Remove from favorites', exact: true }),
    ).toBeVisible();
    await preview.getByRole('button', { name: 'Close sticker preview' }).click();
    await picker.getByRole('button', { name: 'Manage sticker packs', exact: true }).click();
    const manager = page.getByRole('dialog', { name: 'Manage sticker packs', exact: true });
    await manager.getByRole('searchbox', { name: 'Search sticker packs' }).fill('cats');
    await manager.getByRole('button', { name: /Fixture Cats/ }).click();
    await manager.getByRole('button', { name: 'Add pack', exact: true }).click();
    await expect(manager.getByRole('button', { name: 'Remove pack', exact: true })).toBeVisible();
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('sticker-pack.png'),
    });
    await manager.getByRole('button', { name: 'Remove pack', exact: true }).click();
    await expect(manager.getByRole('button', { name: 'Add pack', exact: true })).toBeVisible();
    await manager.getByRole('button', { name: 'Close sticker packs' }).click();
    await sticker.click();
    await expect
      .poll(() => page.evaluate(() => window.__televechaFixture!.stats.sendSticker))
      .toBe(before + 1);
  });
}
