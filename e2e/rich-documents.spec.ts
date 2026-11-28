import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, selectAlice } from './helpers';

for (const width of [1326, 390]) {
  test(`renders and downloads two rich TXT documents at ${width}px`, async ({ page }, testInfo) => {
    await openReady(page);
    await selectAlice(page);
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() =>
      window.__televechaFixture!.emit({
        type: 'new-message',
        pts: 11,
        ptsCount: 1,
        message: {
          id: 81,
          peerId: 'u:101',
          senderId: 'u:101',
          date: 1_700_002_000,
          outgoing: false,
          text: '',
          richMessage: {
            blocks: ['aaa.txt', 'bbb.txt'].map((name, index) => ({
              kind: 'media' as const,
              mediaKind: 'file' as const,
              id: String(index + 1),
              attachment: {
                kind: 'file' as const,
                name,
                mimeType: 'text/plain',
                size: 3,
                cacheKey: `document:${index + 1}`,
              },
              caption: { text: { kind: 'text' as const, text: index ? 'БББ' : 'AAA' } },
            })),
          },
        },
      }),
    );
    const rich = page.locator('.rich-message').filter({ hasText: 'aaa.txt' });
    await expect(rich.locator('.media-attachment')).toHaveCount(2);
    await expect(rich).toContainText('AAA');
    await expect(rich).toContainText('БББ');
    await expect(rich).not.toContainText('Unsupported');
    expect(await rich.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const name of ['aaa.txt', 'bbb.txt']) {
      const download = page.waitForEvent('download');
      await rich.getByRole('button', { name: `Download ${name}`, exact: true }).click();
      expect((await download).suggestedFilename()).toBe(name);
    }
    await page.screenshot({
      path: testInfo.outputPath(`rich-documents-${width}.png`),
      animations: 'disabled',
    });
  });
}

test('activates rich message buttons and keeps disabled buttons inert', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openReady(page);
  await selectAlice(page);
  await page.evaluate(() =>
    window.__televechaFixture!.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        date: 1_700_002_000,
        outgoing: false,
        text: '',
        richMessage: {
          blocks: [
            {
              kind: 'text',
              role: 'paragraph',
              text: {
                kind: 'button',
                child: { kind: 'text', text: 'Copy inline' },
                button: { kind: 'copy', text: 'Copy inline', copyText: 'inline value' },
              },
            },
            {
              kind: 'buttons',
              align: 'center',
              buttons: [
                { kind: 'copy', text: 'Copy row', copyText: 'row value' },
                { kind: 'disabled', text: 'Unavailable' },
              ],
            },
          ],
        },
      },
    }),
  );
  const rich = page.locator('.rich-message').filter({ hasText: 'Copy inline' });
  await rich.getByRole('button', { name: 'Copy inline' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('inline value');
  await rich.getByRole('button', { name: 'Copy row' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('row value');
  await expect(rich.getByRole('button', { name: 'Unavailable' })).toBeDisabled();
});
