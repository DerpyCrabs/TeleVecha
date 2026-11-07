import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';

for (const width of [375, 768, 1280]) {
  test(`shows paged public poll voters and filters by answer at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openReady(page, '/?chat=g%3A303');
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => {
      const message = {
        id: 901,
        peerId: 'g:303',
        senderId: 'u:101',
        text: '',
        date: Math.floor(Date.now() / 1000),
        outgoing: false,
        poll: {
          id: 'public-voters-test',
          hash: '0',
          question: 'Choose a day',
          answers: [
            { option: '00', text: 'Saturday' },
            { option: '01', text: 'Sunday' },
          ],
          closed: false,
          publicVoters: true,
          multipleChoice: false,
          quiz: false,
          revotingDisabled: false,
          hideResultsUntilClose: false,
          results: {
            totalVoters: 5,
            answers: [
              { option: '00', voters: 3, chosen: true },
              { option: '01', voters: 2 },
            ],
          },
        },
      };
      window.__televechaFixture!.setMessages([message]);
      window.__televechaFixture!.emit({ type: 'new-message', pts: 11, ptsCount: 1, message });
    });
    await page.getByRole('button', { name: 'View results', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Poll results', exact: true });
    await expect(dialog.locator('.read-receipt-person')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Show more votes' }).click();
    await expect(dialog.locator('.read-receipt-person')).toHaveCount(4);
    await dialog.getByRole('button', { name: 'Show more votes' }).click();
    await expect(dialog.locator('.read-receipt-person')).toHaveCount(5);
    await expect(dialog.getByRole('button', { name: 'Show more votes' })).toHaveCount(0);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath('poll-voters.png') });
    await dialog.getByRole('button', { name: 'Sunday', exact: true }).click();
    await expect(dialog.locator('.read-receipt-person')).toHaveCount(2);
    await expect(dialog.locator('.poll-voters-list')).not.toContainText('Saturday');
  });
}
