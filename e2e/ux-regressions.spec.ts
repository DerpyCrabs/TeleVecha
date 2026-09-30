import { test } from '@playwright/test';
import { expect } from './expect';

import { openReady, selectAlice } from './helpers';

test('lays a 100-sticker pack out as a non-overlapping square grid', async ({ page }) => {
  await openReady(page, '/?scenario=large-sticker-pack');
  await selectAlice(page);
  await page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' }).click();
  const picker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
  await picker.getByRole('button', { name: 'Stickers' }).click();
  await picker.getByRole('button', { name: 'Large Fixture Pack' }).click();
  const cells = picker.locator('.sticker-option');
  await expect(cells).toHaveCount(100);
  await expect(cells.first()).toBeVisible();
  await expect(cells.locator('img, video, .tgs-player').first()).toBeVisible();
  const pickerOrder = await picker.evaluate((element) => {
    const grid = element.querySelector('.sticker-pack-grid')!.getBoundingClientRect();
    const packs = element.querySelector('.sticker-pack-tabs')!.getBoundingClientRect();
    return { gridBottom: grid.bottom, packsTop: packs.top };
  });
  expect(pickerOrder.packsTop).toBeGreaterThanOrEqual(pickerOrder.gridBottom - 1);
  const packTabs = picker.locator('.sticker-pack-tabs');
  await packTabs.evaluate((element) => {
    element.setAttribute('style', 'width: 70px');
  });
  await packTabs.dispatchEvent('wheel', { deltaY: 100 });
  expect(await packTabs.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const boxes = await cells.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }),
  );
  for (const box of boxes) {
    expect(box.right - box.left).toBeGreaterThan(50);
    expect(Math.abs(box.right - box.left - (box.bottom - box.top))).toBeLessThan(1);
  }
  expect(new Set(boxes.map(({ left }) => Math.round(left))).size).toBe(4);
  expect(new Set(boxes.map(({ top }) => Math.round(top))).size).toBe(25);
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(
        true,
      );
    }
  }
  const overflow = await cells.evaluateAll((elements) =>
    elements.map((element) => {
      const cell = element.getBoundingClientRect();
      const visual = element.querySelector('img, video, .tgs-player')?.getBoundingClientRect();
      return visual
        ? {
            left: visual.left - cell.left,
            top: visual.top - cell.top,
            right: visual.right - cell.right,
            bottom: visual.bottom - cell.bottom,
          }
        : { left: 0, top: 0, right: 0, bottom: 0 };
    }),
  );
  for (const edge of overflow) {
    expect(edge.left).toBeGreaterThanOrEqual(-1);
    expect(edge.top).toBeGreaterThanOrEqual(-1);
    expect(edge.right).toBeLessThanOrEqual(1);
    expect(edge.bottom).toBeLessThanOrEqual(1);
  }
  expect(
    await cells
      .locator('img, video')
      .first()
      .evaluate((element) => getComputedStyle(element).objectFit),
  ).toBe('contain');
  const firstAssetRatio = await cells
    .locator('img')
    .first()
    .evaluate((element: HTMLImageElement) => ({
      intrinsic: element.naturalWidth / element.naturalHeight,
      rendered: element.getBoundingClientRect().width / element.getBoundingClientRect().height,
    }));
  expect(firstAssetRatio.intrinsic).toBe(2);
  expect(firstAssetRatio.rendered).toBeCloseTo(1, 1);
  const gridScroll = await picker.locator('.sticker-pack-grid').evaluate((element) => {
    const before = element.scrollTop;
    element.scrollTop = element.scrollHeight;
    return {
      before,
      after: element.scrollTop,
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(gridScroll.scrollHeight).toBeGreaterThan(gridScroll.clientHeight);
  expect(gridScroll.after).toBeGreaterThan(gridScroll.before);
  expect(gridScroll.scrollWidth).toBeLessThanOrEqual(gridScroll.clientWidth + 1);
});

test('dismisses transient menus and dialogs and keeps the conversation through updates', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('hides the chat-list scrollbar without disabling scrolling', async () => {
    const list = page.getByTestId('chat-list');
    const result = await list.evaluate((element) => {
      element.style.maxHeight = '120px';
      element.scrollTop = 80;
      return {
        scrollbarWidth: getComputedStyle(element).scrollbarWidth,
        scrollTop: element.scrollTop,
      };
    });
    expect(result.scrollbarWidth).toBe('none');
    expect(result.scrollTop).toBeGreaterThan(0);
  });
  await test.step('keeps the composer minimal and combines emoji, GIFs, and stickers', async () => {
    await expect(page.getByLabel('Message formatting')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Choose GIF' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Choose sticker' })).toHaveCount(0);

    const trigger = page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' });
    await trigger.click();
    const picker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
    await expect(picker.getByRole('button', { name: 'Emoji' })).toBeVisible();
    await expect(picker.getByRole('button', { name: 'GIFs' })).toBeVisible();
    await expect(picker.getByRole('button', { name: 'Stickers' })).toBeVisible();
    await page.mouse.click(2, 2);
    await expect(picker).toHaveCount(0);
  });
  await test.step('dismisses message and formatting context menus outside and with Escape', async () => {
    await page.locator('article[data-message-id="79"]').click({ button: 'right' });
    const messageMenu = page.getByRole('menu', { name: 'Message actions' });
    await expect(messageMenu).toBeVisible();
    await page.mouse.click(2, 2);
    await expect(messageMenu).toHaveCount(0);

    const input = page.getByRole('textbox', { name: 'Message' });
    await input.fill('format me');
    await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(0, 6));
    await input.dispatchEvent('contextmenu', { clientX: 400, clientY: 500 });
    const formatMenu = page.getByRole('menu', { name: 'Message formatting' });
    await expect(formatMenu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(formatMenu).toHaveCount(0);
  });
  await test.step('dismisses chat actions and every transient dialog consistently', async () => {
    const chat = page.getByRole('button', { name: /Alice Fixture/ });
    await chat.click({ button: 'right' });
    const chatMenu = page.getByRole('menu', { name: 'Chat actions' });
    await expect(chatMenu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(chatMenu).toHaveCount(0);

    await page.getByRole('button', { name: 'Search messages' }).click();
    const search = page.getByRole('dialog', { name: 'Message search' });
    await page.keyboard.press('Escape');
    await expect(search).toHaveCount(0);

    await page
      .locator('.details-pane')
      .getByRole('button', { name: /Photos/ })
      .click();
    const shared = page.getByRole('dialog', { name: 'Shared photos' });
    await page.keyboard.press('Escape');
    await expect(shared).toHaveCount(0);

    const message = page.locator('article[data-message-id="79"]');
    await message.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const deletion = page.getByRole('dialog', { name: 'Delete message' });
    await page.keyboard.press('Escape');
    await expect(deletion).toHaveCount(0);

    await message.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Forward' }).click();
    const forwarding = page.getByRole('dialog', { name: 'Forward message' });
    await page.mouse.click(2, 2);
    await expect(forwarding).toHaveCount(0);
  });
  await test.step('an incoming media update never replaces the conversation with a loading screen', async () => {
    await page.evaluate(() =>
      window.__televechaFixture?.emit({
        type: 'new-message',
        pts: 11,
        ptsCount: 1,
        message: {
          id: 81,
          peerId: 'u:101',
          senderId: 'u:101',
          text: 'Incoming image',
          date: Math.floor(Date.now() / 1000),
          outgoing: false,
          media: { kind: 'photo', name: 'incoming.jpg', mimeType: 'image/jpeg' },
        },
      }),
    );
    await expect(page.locator('article[data-message-id="79"]')).toBeAttached();
    await expect(page.locator('article[data-message-id="81"]')).toBeVisible();
    await expect(page.getByText('Loading messages…')).toHaveCount(0);
    const visual = page.locator('article[data-message-id="81"] .media-visual');
    const box = await visual.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThan(page.viewportSize()!.width / 2);
    expect(box!.height).toBeLessThan(page.viewportSize()!.height / 2);
  });
  await test.step('background catch-up never reopens the full-screen connection loader', async () => {
    await page.evaluate(() => window.__televechaFixture?.emit({ type: 'too-long' }));
    await expect(
      page.getByRole('dialog', { name: /Loading chats|Connecting to Telegram/ }),
    ).toHaveCount(0);
    await expect(page.getByTestId('message-scroller')).toBeVisible();
  });
  await test.step('styles vertical scrollbars and hides horizontal scrollbar tracks', async () => {
    await page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' }).click();
    const picker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
    const emojiGrid = picker.locator('.emoji-grid');
    await expect(emojiGrid).toBeVisible();
    await expect
      .poll(() => emojiGrid.evaluate((element) => getComputedStyle(element).scrollbarWidth))
      .toBe('thin');

    await picker.getByRole('button', { name: 'Stickers' }).click();
    const packTabs = picker.locator('.sticker-pack-tabs');
    await expect(packTabs).toBeVisible();
    expect(await packTabs.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe(
      'none',
    );
  });
});
