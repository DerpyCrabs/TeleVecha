import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, chatButton } from './helpers';
for (const width of [1280, 375]) {
  test(`opens advanced settings after upgrading a group at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openReady(page);
    await page.setViewportSize({ width, height: 800 });
    if (width <= 650)
      await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
    await chatButton(page, /Fixture Group/).click();
    if (await page.getByRole('button', { name: 'Open details', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Open details', exact: true }).click();
    await page.getByRole('button', { name: 'Manage group', exact: true }).click();
    const manager = page.getByRole('dialog', { name: 'Manage group', exact: true });
    await manager.getByRole('button', { name: /^Topics/ }).click();
    const confirm = page.getByRole('dialog', {
      name: 'Enable advanced group settings?',
      exact: true,
    });
    await expect(confirm).toContainText('cannot be undone');
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(manager).toBeVisible();
    await manager.getByRole('button', { name: /^Topics/ }).click();
    await page.screenshot({
      path: testInfo.outputPath(`upgrade-${width}.png`),
      animations: 'disabled',
    });
    await confirm.getByRole('button', { name: 'Continue', exact: true }).click();
    const topics = page.getByRole('dialog', { name: 'Topics', exact: true });
    await expect(topics).toBeVisible();
    await expect(page.getByTestId('conversation-header')).toContainText('Fixture Group');
    await topics.getByRole('radio', { name: 'Enabled', exact: true }).check();
    await topics.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page
        .getByTestId('conversation-header')
        .getByRole('button', { name: 'Show topics', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('message-scroller')).toContainText('Group fixture message');
    await expect(page).toHaveURL(/chat=c%3A7000/);
    await expect(
      page.getByTestId('message-scroller').getByText('No messages yet', { exact: true }),
    ).toHaveCount(0);
    if (await page.getByRole('button', { name: 'Close details', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Close details', exact: true }).click();
    if (width <= 650)
      await page
        .getByRole('complementary', { name: 'Forum topics' })
        .getByRole('button', { name: /^General/ })
        .click();
    await expect(
      page.getByTestId('message-scroller').getByText('Group fixture message', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`unified-history-${width}.png`),
      animations: 'disabled',
    });
    if (await page.getByRole('button', { name: 'Open details', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Open details', exact: true }).click();
    await page.getByRole('button', { name: /Earlier group history/ }).click();
    await expect(page.getByTestId('message-scroller')).toContainText('Group fixture message');
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).not.toBeEditable();
    if (await page.getByRole('button', { name: 'Open details', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Open details', exact: true }).click();
    await expect(page.getByRole('button', { name: /Open current group/ })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`earlier-history-${width}.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: /Open current group/ }).click();
    await expect(page).toHaveURL(/chat=c%3A7000/);
    if (width <= 650)
      await page
        .getByRole('complementary', { name: 'Forum topics' })
        .getByRole('button', { name: /^General/ })
        .click();
    await page.getByRole('button', { name: 'Search messages', exact: true }).click();
    const search = page.locator('.search-panel');
    await search.getByRole('searchbox', { name: 'Message search query' }).fill('Group fixture');
    await expect(search.locator('.search-results')).toContainText('Group fixture message');
  });
}

for (const held of [false, true]) {
  test(`prepends migrated history without moving the reading position or mixing message ids${held ? ' with a pending request' : ''}`, async ({
    page,
  }) => {
    await openReady(page, held ? '/?scenario=held-earlier-history' : '/');
    await page.evaluate(() =>
      window.__televechaFixture?.setMessages(
        Array.from({ length: 180 }, (_, index) => ({
          id: index + 1,
          peerId: 'g:303',
          senderId: 'u:101',
          senderName: 'Alice Fixture',
          text: `Earlier message ${index + 1}`,
          date: 1700000000 + index * 60,
          outgoing: false,
        })),
      ),
    );
    await chatButton(page, /Fixture Group/).click();
    if (await page.getByRole('button', { name: 'Open details', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Open details', exact: true }).click();
    await page.getByRole('button', { name: 'Manage group', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Manage group', exact: true })
      .getByRole('button', { name: /^Topics/ })
      .click();
    await page
      .getByRole('dialog', { name: 'Enable advanced group settings?', exact: true })
      .getByRole('button', { name: 'Continue', exact: true })
      .click();
    const topics = page.getByRole('dialog', { name: 'Topics', exact: true });
    await topics.getByRole('radio', { name: 'Enabled', exact: true }).check();
    await topics.getByRole('button', { name: 'Save', exact: true }).click();
    if (await page.getByRole('button', { name: 'Close details', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Close details', exact: true }).click();
    const scroller = page.getByTestId('message-scroller');
    const earlier = (id: number) => scroller.locator(`[data-source-message="${id}"]`);
    await expect(earlier(180)).toBeVisible();
    await expect(earlier(1)).toHaveCount(0);
    const anchorTop = await scroller.evaluate((element, pending) => {
      element.scrollTop = 0;
      const top = element.querySelector('[data-source-message="131"]')!.getBoundingClientRect().top;
      // Start loading before the browser delivers the scroll event, reproducing the
      // IntersectionObserver/scroll ordering that occurs under load.
      if (pending)
        element
          .querySelector<HTMLButtonElement>('.earlier-group-history .message-window-control')!
          .click();
      return top;
    }, held);
    if (held) {
      await expect(page.getByText('Loading earlier messages…', { exact: true })).toBeVisible();
      // Let layout observers run while the response is held, as on a slow connection.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(Math.abs((await earlier(131).boundingBox())!.y - anchorTop)).toBeLessThan(4);
      await page.screenshot({ path: '/tmp/earlier-history-loading.png' });
      await page.evaluate(() => window.__televechaFixture!.releaseHistory());
    }
    await expect(earlier(81)).toHaveCount(1);
    await expect
      .poll(async () => Math.abs((await earlier(131).boundingBox())!.y - anchorTop))
      .toBeLessThan(4);
    for (const target of [31, 1]) {
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(earlier(target)).toHaveCount(1);
    }
    await page.evaluate(() =>
      window.__televechaFixture?.emit({
        type: 'new-message',
        pts: 11,
        ptsCount: 1,
        channelScoped: true,
        message: {
          id: 12,
          peerId: 'c:7000',
          senderId: 'u:101',
          senderName: 'Alice Fixture',
          text: 'Current group message',
          date: 1701000000,
          outgoing: false,
        },
      }),
    );
    await expect(scroller.locator('[data-message-id="12"]')).toContainText('Current group message');
    await expect(earlier(12)).toContainText('Earlier message 12');
    await expect(page).toHaveURL(/chat=c%3A7000/);
  });
}
