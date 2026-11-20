import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, selectAlice } from './helpers';
for (const width of [1326, 390]) {
  test(`keeps archive album download rows readable at ${width}px`, async ({ page }) => {
    await openReady(page, '/?scenario=held-media-download');
    await selectAlice(page);
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => {
      for (let index = 0; index < 2; index++)
        window.__televechaFixture!.emit({
          type: 'new-message',
          pts: 11 + index,
          ptsCount: 1,
          message: {
            id: 81 + index,
            peerId: 'u:101',
            senderId: 'u:101',
            date: 1_700_002_000 + index,
            outgoing: false,
            groupedId: 'archive-album',
            forwardedFrom: { name: 'tg_mcp' },
            text:
              index === 0
                ? 'Рой домой 1.0.0 для Google Play — часть 1 (swarm-home-1.0.0.z01). Обе части скачайте в одну папку.'
                : 'Вторая часть архива.',
            media: {
              kind: 'file',
              name: index === 0 ? 'swarm-home-1.0.0.z01' : 'swarm-home-1.0.0.zip',
              mimeType: index === 0 ? 'application/octet-stream' : 'application/zip',
              size: index === 0 ? 45 * 1024 ** 2 : 41.1 * 1024 ** 2,
            },
          },
        });
    });
    const album = page.locator('.file-album');
    await expect(album.locator('.media-album-item')).toHaveCount(2);
    const measure = () =>
      album.locator('.media-attachment').evaluateAll((elements) =>
        elements.map((element) => {
          const button = element.querySelector('.media-file-details')!;
          const title = button.querySelector('strong')!;
          return {
            columns: getComputedStyle(element).gridTemplateColumns,
            outerWidth: element.getBoundingClientRect().width,
            buttonWidth: button.getBoundingClientRect().width,
            titleWidth: title.getBoundingClientRect().width,
            height: button.getBoundingClientRect().height,
            overflow: element.scrollWidth > element.clientWidth,
          };
        }),
      );
    const before = await measure();
    await page.screenshot({ path: `/tmp/archive-before-${width}.png`, animations: 'disabled' });
    await album.getByRole('button', { name: 'Download swarm-home-1.0.0.z01', exact: true }).click();
    await album.getByRole('button', { name: 'Download swarm-home-1.0.0.zip', exact: true }).click();
    await expect(
      album.getByRole('button', { name: 'Cancel download swarm-home-1.0.0.zip' }),
    ).toBeVisible();
    await expect(album.getByText('25% downloaded', { exact: true })).toHaveCount(2);
    const during = await measure();
    expect(during).toEqual(before);
    await page.screenshot({ path: `/tmp/archive-during-${width}.png`, animations: 'disabled' });
    for (const row of during) {
      expect(row.titleWidth).toBeGreaterThan(80);
      expect(row.buttonWidth).toBeGreaterThan(200);
      expect(row.height).toBeLessThan(110);
      expect(row.overflow).toBe(false);
    }
    await album.getByRole('button', { name: 'Cancel download swarm-home-1.0.0.z01' }).click();
    await album.getByRole('button', { name: 'Cancel download swarm-home-1.0.0.zip' }).click();
    await expect(
      album.getByRole('button', { name: 'Download swarm-home-1.0.0.zip', exact: true }),
    ).toBeEnabled();
  });

  test(`keeps a long document name readable at ${width}px`, async ({ page }) => {
    const name = '4000_Essential_English_Words_all_books.zip';
    await openReady(page, '/?scenario=held-media-download');
    await selectAlice(page);
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(
      (name) =>
        window.__televechaFixture!.emit({
          type: 'new-message',
          pts: 11,
          ptsCount: 1,
          message: {
            id: 81,
            peerId: 'u:101',
            senderId: 'u:101',
            date: 1700002000,
            outgoing: false,
            text: '',
            media: { kind: 'file', name, mimeType: 'application/octet-stream', size: 204682035 },
          },
        }),
      name,
    );
    const download = page.getByRole('button', { name: `Download ${name}`, exact: true });
    const attachment = page.locator('.media-attachment').filter({ hasText: name });
    const rightGap = async (action: typeof download) => {
      const card = (await attachment.boundingBox())!;
      const button = (await action.boundingBox())!;
      return card.x + card.width - button.x - button.width;
    };
    expect(Math.abs(await rightGap(download))).toBeLessThan(1);
    await download.click();
    const row = page.locator('.message').filter({ hasText: name });
    await expect(row.getByText('25% downloaded')).toBeVisible();
    const cancel = row.getByRole('button', { name: `Cancel download ${name}` });
    const titleBox = (await row.locator('strong').boundingBox())!;
    const cancelBox = (await cancel.boundingBox())!;
    expect(Math.abs(await rightGap(cancel))).toBeLessThan(1);
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(cancelBox.x + 1);
    expect(cancelBox.x + cancelBox.width).toBeLessThanOrEqual(width);
    await row.screenshot({ path: `/tmp/document-${width}.png` });
    await cancel.click();
    await expect(download).toBeEnabled();
  });
}
