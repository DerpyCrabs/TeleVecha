import { test, type Locator } from '@playwright/test';
import { expect } from './expect';

import { openReady, selectAlice } from './helpers';

test.beforeEach(async ({ page }) => {
  await openReady(page);
});

async function expectSelectedDialogStyle(dialog: Locator) {
  await expect(dialog).toHaveClass(/\bactive\b/u);
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
        const channels = (getComputedStyle(element).backgroundColor.match(/[\d.]+/gu) ?? []).map(
          Number,
        );
        const [red = 0, green = 0, blue = 0, alpha = 1] = channels;
        return alpha === 1 && blue > red && green > red;
      }),
    )
    .toBe(true);
}

test('opens and closes the chat drawer on a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sidebar = page.getByTestId('chat-sidebar');
  await page.getByRole('button', { name: 'Open chat list' }).click();
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().left))
    .toBeGreaterThanOrEqual(0);
  await sidebar.getByRole('button', { name: /Release Channel/ }).click();
  await expect(page.getByRole('button', { name: 'Open chat list' })).toBeVisible();
  await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready');
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);
});

test('keeps the conversation and modal inside an intermediate viewport', async ({ page }) => {
  await page.setViewportSize({ width: 660, height: 800 });
  await expect
    .poll(() =>
      page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      })),
    )
    .toEqual({ client: 660, scroll: 660 });

  const separator = page.getByRole('separator', { name: 'Resize chat list' });
  await expect(separator).toHaveAttribute('aria-valuemax', '300');
  await expect(separator).toHaveAttribute('aria-valuenow', '300');
  await separator.focus();
  await separator.press('ArrowLeft');
  await expect(separator).toHaveAttribute('aria-valuenow', '284');

  await page.getByRole('button', { name: 'Search messages' }).click();
  const panel = page.locator('.search-panel[aria-label="Message search"]');
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(660);
});

test('resizes the chat sidebar and restores its width after reload', async ({ page }) => {
  const sidebar = page.getByTestId('chat-sidebar');
  const separator = page.getByRole('separator', { name: 'Resize chat list' });
  const handle = await separator.boundingBox();
  if (!handle) throw new Error('Chat-list resize handle is not visible');

  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x - 65, handle.y + 100);
  await page.mouse.up();

  await expect(separator).toHaveAttribute('aria-valuenow', '250');
  await expect
    .poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
    .toBe(250);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('televecha:left-sidebar-width')))
    .toBe('250');

  await page.reload();
  await expect(separator).toHaveAttribute('aria-valuenow', '250');
  await expect
    .poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
    .toBe(250);
});

test('keeps every chat filter reachable without a visible horizontal scrollbar', async ({
  page,
}) => {
  const separator = page.getByRole('separator', { name: 'Resize chat list' });
  await separator.focus();
  for (let step = 0; step < 11; step += 1) await separator.press('ArrowLeft');

  const filters = page.locator('.chat-filters');
  await expect(filters).toBeVisible();
  await expect
    .poll(() =>
      filters.evaluate((element) => ({
        overflows: element.scrollWidth > element.clientWidth,
        scrollbarWidth: getComputedStyle(element).scrollbarWidth,
        webkitScrollbarDisplay: getComputedStyle(element, '::-webkit-scrollbar').display,
      })),
    )
    .toEqual({ overflows: true, scrollbarWidth: 'none', webkitScrollbarDisplay: 'none' });

  const filterBox = await filters.boundingBox();
  if (!filterBox) throw new Error('Chat filters are not visible');
  await page.mouse.move(filterBox.x + filterBox.width / 2, filterBox.y + filterBox.height / 2);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => filters.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  const archived = page.getByRole('button', { name: 'Archived', exact: true });
  await archived.click();
  await expect(archived).toHaveAttribute('aria-pressed', 'true');
});

test('switches compact content while the resize pointer is still down', async ({ page }) => {
  const sidebar = page.getByTestId('chat-sidebar');
  const separator = page.getByRole('separator', { name: 'Resize chat list' });
  const handle = await separator.boundingBox();
  if (!handle) throw new Error('Chat-list resize handle is not visible');

  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x - 260, handle.y + 100);

  await expect(sidebar).toHaveAttribute('data-compact', 'true');
  await expect(page.getByRole('textbox', { name: 'Search chats' })).not.toBeVisible();

  await page.mouse.up();
});

test('marks the open dialog with a blue tile at every sidebar width', async ({ page }) => {
  const sidebar = page.getByTestId('chat-sidebar');
  const chatList = page.getByTestId('chat-list');
  const alice = chatList.getByRole('button', { name: /Alice Fixture/ });

  await alice.click();
  await expect(sidebar).toHaveAttribute('data-compact', 'false');
  await expect(alice.locator('.avatar-online-indicator')).toHaveCount(0);
  await expectSelectedDialogStyle(alice);

  const separator = page.getByRole('separator', { name: 'Resize chat list' });
  await separator.focus();
  await separator.press('Home');

  await expect(sidebar).toHaveAttribute('data-compact', 'true');
  await expect(alice.locator('.avatar-online-indicator')).toHaveCount(0);
  await expectSelectedDialogStyle(alice);
  const compactEdges = await alice.evaluate((element) => {
    const sidebarElement = element.closest<HTMLElement>('[data-testid="chat-sidebar"]');
    if (!sidebarElement) throw new Error('Selected dialog is not inside the chat sidebar');
    const dialogBox = element.getBoundingClientRect();
    const sidebarBox = sidebarElement.getBoundingClientRect();
    return {
      left: Math.abs(dialogBox.left - sidebarBox.left),
      right: Math.abs(dialogBox.right - sidebarBox.right),
    };
  });
  expect(compactEdges.left).toBeLessThanOrEqual(1);
  expect(compactEdges.right).toBeLessThanOrEqual(1);
});

test('coalesces a burst of resize events without rerendering chat or message nodes', async ({
  page,
}) => {
  await selectAlice(page);
  await page.waitForFunction(() => {
    const current = document.querySelector('article[data-message-id="79"]');
    return new Promise<boolean>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          resolve(current === document.querySelector('article[data-message-id="79"]')),
        ),
      ),
    );
  });
  const result = await page
    .getByRole('separator', { name: 'Resize chat list' })
    .evaluate(async (separator) => {
      const grid = document.querySelector<HTMLElement>('.app-grid')!;
      const chat = document.querySelector<HTMLElement>('[data-testid="chat-list"] .chat-row')!;
      const message = document.querySelector<HTMLElement>('article[data-message-id="79"]')!;
      const startX = separator.getBoundingClientRect().left;
      let styleWrites = 0;
      const observer = new MutationObserver((records) => {
        styleWrites += records.filter(
          (record) => record.type === 'attributes' && record.attributeName === 'style',
        ).length;
      });
      observer.observe(grid, { attributes: true });
      separator.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: startX }),
      );
      for (let index = 0; index < 200; index += 1) {
        window.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, clientX: startX + (index % 120) }),
        );
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      observer.disconnect();
      return {
        styleWrites,
        sameChat: chat === document.querySelector('[data-testid="chat-list"] .chat-row'),
        sameMessage: message === document.querySelector('article[data-message-id="79"]'),
      };
    });

  expect(result.styleWrites).toBeLessThanOrEqual(3);
  expect(result.sameChat).toBe(true);
  expect(result.sameMessage).toBe(true);
});

test('collapses an excessively narrow chat sidebar to avatar-only rows', async ({ page }) => {
  const sidebar = page.getByTestId('chat-sidebar');
  const separator = page.getByRole('separator', { name: 'Resize chat list' });
  await separator.focus();
  await separator.press('Home');

  await expect(sidebar).toHaveAttribute('data-compact', 'true');
  await expect(separator).toHaveAttribute('aria-valuenow', '72');
  await expect(page.getByRole('textbox', { name: 'Search chats' })).not.toBeVisible();
  await expect(page.getByTestId('chat-list').locator('img').first()).toBeVisible();
  await expect(
    page.getByTestId('chat-list').getByRole('button', { name: /Alice Fixture/ }),
  ).toBeVisible();
  const bottomPanelHeights = await page.evaluate(() => ({
    settingsPanel: document
      .querySelector<HTMLElement>('.sidebar-settings-footer')!
      .getBoundingClientRect().height,
    composerPanel: document.querySelector<HTMLElement>('.chat-composer')!.getBoundingClientRect()
      .height,
    settingsButton: document
      .querySelector<HTMLElement>('.sidebar-settings-footer button')!
      .getBoundingClientRect().height,
    composerPrompt: document.querySelector<HTMLElement>('.composer')!.getBoundingClientRect()
      .height,
  }));
  expect(
    Math.abs(bottomPanelHeights.settingsPanel - bottomPanelHeights.composerPanel),
  ).toBeLessThan(1);
  expect(
    Math.abs(bottomPanelHeights.settingsButton - bottomPanelHeights.composerPrompt),
  ).toBeLessThan(1);
  const selected = page.getByTestId('chat-list').getByRole('button', { name: /Alice Fixture/ });
  await selected.click();
  await expect(selected).toHaveCSS('border-radius', '0px');
  await expect(selected).toHaveCSS('box-shadow', 'none');

  await separator.press('End');
  await expect(sidebar).toHaveAttribute('data-compact', 'false');
  await expect(page.getByRole('textbox', { name: 'Search chats' })).toBeVisible();
});

test('keeps an escape route visible from Archived in compact mode', async ({ page }) => {
  const alice = page.getByTestId('chat-list').getByRole('button', { name: /Alice Fixture/ });
  await alice.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive chat' }).click();

  const separator = page.getByRole('separator', { name: 'Resize chat list' });
  await separator.focus();
  await separator.press('Home');
  await page.getByRole('button', { name: /Archived chats, 1/ }).click();

  const back = page.getByRole('button', { name: 'Back to chats' });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page.getByRole('button', { name: /Archived chats, 1/ })).toBeVisible();
});

test('animates and remembers the closed details pane', async ({ page }) => {
  const details = page.locator('aside.details-pane');
  await expect(details).toHaveCSS('opacity', '1');
  expect(
    await details.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).transitionDuration),
    ),
  ).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(details).toHaveCSS('opacity', '0');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('televecha:details-open')))
    .toBe('false');

  await page.reload();
  await expect(details).toHaveCSS('opacity', '0');
  await expect(page.getByRole('button', { name: 'Open details' })).toBeVisible();
  await page.getByRole('button', { name: 'Open details' }).click();
  await expect(details).toHaveCSS('opacity', '1');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('televecha:details-open')))
    .toBe('true');
});
