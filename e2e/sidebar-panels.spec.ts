import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, chatButton } from './helpers';

for (const width of [375, 660, 1280]) {
  for (const kind of ['forum', 'saved'] as const) {
    test(`${kind} navigation stays usable from a collapsed chat list at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.addInitScript(() => {
        localStorage.setItem('televecha:left-sidebar-width', '72');
        localStorage.setItem('televecha:details-open', 'false');
      });
      await openReady(page, '/?scenario=forums');
      await page.setViewportSize({ width, height: 800 });
      if (width <= 650)
        await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
      if (kind === 'forum') {
        await chatButton(page, /Release Channel/).click();
      } else {
        await page.getByRole('button', { name: 'Open main menu', exact: true }).click();
        await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
      }
      const panel = page.getByRole('complementary', {
        name: kind === 'forum' ? 'Forum topics' : 'Saved chats',
        exact: true,
      });
      await expect(panel).toBeVisible();
      expect((await panel.boundingBox())!.width).toBeGreaterThanOrEqual(
        width <= 650 ? Math.min(320, width * 0.88) : Math.min(320, width - 360),
      );
      const query = panel.getByRole('textbox', {
        name: kind === 'forum' ? 'Search topics' : 'Search saved chats',
        exact: true,
      });
      expect((await query.boundingBox())!.width).toBeGreaterThan(150);
      await query.fill(kind === 'forum' ? 'Development' : 'Alice');
      await expect(
        panel.getByRole('button', {
          name: kind === 'forum' ? /^Development/ : /Alice Fixture Saved from Alice/,
        }),
      ).toBeVisible();
      await expect.poll(async () => (await panel.boundingBox())!.x).toBe(0);
      await page.screenshot({
        path: testInfo.outputPath('navigation-panel.png'),
        animations: 'disabled',
      });
      await panel.getByRole('button', { name: 'Back to chats', exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect(page.getByTestId('chat-list')).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('televecha:left-sidebar-width'))).toBe(
        '72',
      );
      if (width > 650)
        await expect
          .poll(async () => (await page.getByTestId('chat-sidebar').boundingBox())!.width)
          .toBe(72);
    });
  }
}
