import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';

for (const width of [375, 768, 1280]) {
  test(`image tools preserve undo history and apply the edit at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openReady(page, '/?chat=u%3A101');
    await page.setViewportSize({ width, height: 800 });
    await page
      .locator('.chat-composer input[type=file]')
      .setInputFiles('e2e/fixtures/outgoing-media.png');
    await page.getByRole('button', { name: 'Edit image outgoing-media.png' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit image' });
    const canvas = editor.locator('canvas');
    await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBe(192);
    await editor.getByRole('combobox', { name: 'Crop aspect ratio' }).selectOption('square');
    await editor.getByRole('button', { name: 'Rotate right' }).click();
    await editor.getByRole('button', { name: 'Draw', exact: true }).click();
    await expect(editor.getByRole('combobox', { name: 'Crop aspect ratio' })).toHaveCount(0);
    await expect(editor.getByRole('slider', { name: 'Brush size' })).toBeVisible();
    const original = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.75, { steps: 10 });
    await page.mouse.up();
    await expect
      .poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL()))
      .not.toBe(original);
    const drawn = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
    await editor.getByRole('button', { name: 'Undo image edit' }).click();
    await expect
      .poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL()))
      .toBe(original);
    await editor.getByRole('button', { name: 'Redo image edit' }).click();
    await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).toBe(drawn);
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('image-editor.png'),
    });
    await expect(editor.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
    await editor.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect
      .poll(() =>
        page
          .getByTestId('composer-attachment')
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.naturalWidth / img.naturalHeight),
      )
      .toBe(1);
    expect(await page.evaluate(() => window.__televechaFixture!.stats.sendFile)).toBe(0);
  });
}
