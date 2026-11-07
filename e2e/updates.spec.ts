import { test } from '@playwright/test';
import { expect } from './expect';

import { chatButton, fixtureStats, openReady, selectAlice } from './helpers';

test('applies presence and incoming messages, and forwards to another chat', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('updates the header presence from Telegram status updates', async () => {
    const status = page.locator('.chat-header').getByRole('status');
    const sidebarAvatar = chatButton(page, /Alice Fixture/).locator('.avatar-online-indicator');
    const headerAvatar = page.locator('.chat-header .avatar-online-indicator');
    await expect(status).toHaveText('status unavailable');
    await expect(sidebarAvatar).toHaveCount(0);
    await expect(headerAvatar).toHaveCount(0);
    await page.evaluate(() =>
      window.__televechaFixture?.emit({
        type: 'presence-changed',
        peerId: 'u:101',
        presence: 'online',
      }),
    );
    await expect(status).toHaveText('online');
    await expect(sidebarAvatar).toBeVisible();
    await expect(headerAvatar).toBeVisible();
    await page.evaluate(() =>
      window.__televechaFixture?.emit({
        type: 'presence-changed',
        peerId: 'u:101',
        presence: 'recently',
      }),
    );
    await expect(status).toHaveText('last seen recently');
    await expect(sidebarAvatar).toHaveCount(0);
    await expect(headerAvatar).toHaveCount(0);
  });
  await test.step('applies a live incoming message, updates the preview, and marks it read', async () => {
    const readsBefore = (await fixtureStats(page))?.readHistory ?? 0;
    await page.evaluate(() =>
      window.__televechaFixture?.emit({
        type: 'new-message',
        pts: 11,
        ptsCount: 1,
        message: {
          id: 81,
          peerId: 'u:101',
          senderId: 'u:101',
          text: 'Live incoming fixture',
          date: 1_700_002_000,
          outgoing: false,
        },
      }),
    );

    await expect(page.getByTestId('message-scroller')).toContainText('Live incoming fixture');
    await expect(chatButton(page, /Alice Fixture/)).toContainText('Live incoming fixture');
    await expect
      .poll(async () => (await fixtureStats(page))?.readHistory ?? 0)
      .toBeGreaterThan(readsBefore);
  });
  await test.step('forwards a message to another chat from the context menu', async () => {
    const message = page.locator('article[data-message-id="79"]');
    await message.click({ button: 'right' });
    await page
      .getByRole('menu', { name: 'Message actions' })
      .getByRole('menuitem', { name: 'Forward' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Forward message' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Release Channel' }).click();
    await expect(
      page.getByRole('button', { name: 'Forwarding options', exact: true }),
    ).toBeVisible();
    expect((await fixtureStats(page))?.forwardMessage ?? 0).toBe(0);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await fixtureStats(page))?.forwardMessage).toBe(1);

    await chatButton(page, /Release Channel/).click();
    await expect(page.locator('article.message').last()).toContainText('Fixture message 79');
  });
});

test('does not mark a new message read while the window lacks focus', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await expect.poll(async () => (await fixtureStats(page))?.readHistory ?? 0).toBeGreaterThan(0);
  const readsBefore = (await fixtureStats(page))?.readHistory ?? 0;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    window.dispatchEvent(new Event('blur'));
  });
  await page.waitForTimeout(50);

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Background-tab message',
        date: 1_700_002_000,
        outgoing: false,
      },
    }),
  );

  await expect(page.getByTestId('message-scroller')).toContainText('Background-tab message');
  await page.waitForTimeout(100);
  expect((await fixtureStats(page))?.readHistory).toBe(readsBefore);

  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hasFocus');
    window.dispatchEvent(new Event('focus'));
  });
  await expect
    .poll(async () => (await fixtureStats(page))?.readHistory ?? 0)
    .toBeGreaterThan(readsBefore);
});

test('does not mark a new message read while the expression picker covers the chat', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  await expect.poll(async () => (await fixtureStats(page))?.readHistory ?? 0).toBeGreaterThan(0);
  await page.waitForTimeout(50);
  const readsBefore = (await fixtureStats(page))?.readHistory ?? 0;
  await page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' }).click();
  await expect(page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' })).toBeVisible();

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Covered by expression picker',
        date: 1_700_002_000,
        outgoing: false,
      },
    }),
  );

  await expect(
    page.getByTestId('message-scroller').getByText('Covered by expression picker'),
  ).toBeAttached();
  await page.waitForTimeout(100);
  expect((await fixtureStats(page))?.readHistory).toBe(readsBefore);

  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await fixtureStats(page))?.readHistory ?? 0)
    .toBeGreaterThan(readsBefore);
});

test('replaces an edited message instead of duplicating it', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await page.evaluate(() => {
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Before edit',
        date: 1_700_002_000,
        outgoing: false,
      },
    });
    window.__televechaFixture?.emit({
      type: 'edit-message',
      pts: 12,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'After edit',
        date: 1_700_002_000,
        outgoing: false,
        editedAt: 1_700_002_100,
      },
    });
  });

  await expect(
    page.getByTestId('message-scroller').getByText('Before edit', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByTestId('message-scroller').getByText('After edit', { exact: true }),
  ).toHaveCount(1);
  const message = page.locator('article[data-message-id="81"]');
  await expect(message).toHaveCount(1);
  await expect(message.locator('.message-edited')).toHaveText('edited');
});

test('removes deleted messages from the open conversation', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await expect(page.locator('article[data-message-id="79"]')).toBeVisible();
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'delete-messages',
      pts: 11,
      ptsCount: 1,
      peerId: 'u:101',
      messageIds: [79],
    }),
  );
  await expect(page.locator('article[data-message-id="79"]')).toHaveCount(0);
});

test('keeps a message menu through updates until its target disappears', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  const menu = page.getByRole('menu', { name: 'Message actions' });
  const target = page.locator('article[data-message-id="80"]');

  await target.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Message that changes the layout',
        date: 1_700_002_000,
        outgoing: false,
      },
    }),
  );
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Reply' })).toBeFocused();
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'edit-message',
      pts: 12,
      ptsCount: 1,
      message: {
        id: 80,
        peerId: 'u:101',
        senderId: 'self',
        text: 'Edited while the context menu was open',
        date: 1_700_000_080,
        outgoing: true,
        editedAt: 1_700_002_100,
      },
    }),
  );
  await expect(menu).toBeVisible();
  await expect(target).toContainText('Edited while the context menu was open');
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'delete-messages',
      pts: 13,
      ptsCount: 1,
      peerId: 'u:101',
      messageIds: [80],
    }),
  );
  await expect(menu).toHaveCount(0);
});

test('renders a live photo caption and its standard reactions together', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Photo caption from Telegram Desktop',
        date: 1_700_002_000,
        outgoing: false,
        media: { kind: 'photo', name: 'desktop-photo.jpg', mimeType: 'image/jpeg' },
        editedAt: 1_700_002_100,
        reactions: [{ emoji: '👍', count: 1, chosen: false }],
      },
    }),
  );

  const message = page.locator('article[data-message-id="81"]');
  await expect(message).toHaveClass(/message-captioned-media/u);
  await expect(message).toContainText('Photo caption from Telegram Desktop');
  await expect(message.locator('.message-edited')).toHaveText('edited');
  await expect(message.getByRole('img', { name: 'desktop-photo.jpg' })).toBeVisible();
  await expect(message.getByRole('button', { name: 'Add 👍 reaction' })).toContainText('1');
});

test('counts unread updates and edits and deletes from the message menu', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('increments unread count and moves an inactive chat after a new message', async () => {
    await page.evaluate(() =>
      window.__televechaFixture?.emit({
        type: 'new-message',
        pts: 11,
        ptsCount: 1,
        message: {
          id: 13,
          peerId: 'g:303',
          senderId: 'u:404',
          text: 'Unread group update',
          date: 1_700_003_000,
          outgoing: false,
        },
      }),
    );

    const group = chatButton(page, /Fixture Group/);
    await expect(group).toContainText('Unread group update');
    await expect(group).toContainText('3');
    await expect(page.locator('[data-testid="chat-list"] .chat-row').first()).toContainText(
      'Fixture Group',
    );
    await expect(page.getByTestId('message-scroller')).not.toContainText('Unread group update');
  });
  await test.step('edits an outgoing message through the context menu without replacing its bubble', async () => {
    const message = page.locator('article[data-message-id="80"]');
    await message.evaluate((element) => {
      element.dataset.editNode = 'preserved';
    });
    await message.click({ button: 'right' });
    await page
      .getByRole('menu', { name: 'Message actions' })
      .getByRole('menuitem', { name: 'Edit' })
      .click();
    await expect(page.getByTestId('composer-edit')).toBeVisible();
    await page.getByRole('textbox', { name: 'Message' }).fill('Edited from context menu');
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect(message).toContainText('Edited from context menu');
    await expect(message.locator('.message-edited')).toHaveText('edited');
    await expect(message.locator('footer')).toHaveAttribute(
      'aria-label',
      /^Edited\. .+\. Message status: sent$/u,
    );
    await expect(message).toHaveAttribute('data-edit-node', 'preserved');
    expect((await fixtureStats(page))?.editMessage).toBe(1);
  });
  await test.step('deletes through the message context menu and restores the previous dialog preview', async () => {
    const top = page.locator('article[data-message-id="80"]');
    await top.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Message actions' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Delete' }).click();
    await page
      .getByRole('dialog', { name: 'Delete message' })
      .getByRole('button', { name: 'Delete for everyone' })
      .click();

    await expect(top).toHaveCount(0);
    await expect(chatButton(page, /Alice Fixture/)).toContainText('Fixture message 79');
    expect((await fixtureStats(page))?.deleteMessages).toBe(1);
  });
});

test('shows every message that arrives while the opened chat is still loading', async ({
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  await page.evaluate(() => {
    for (const [index, id] of [81, 82].entries()) {
      const message = {
        id,
        peerId: 'u:101',
        senderId: 'u:101',
        text: `Arrived while loading ${id}`,
        date: Math.floor(Date.now() / 1000) + index,
        outgoing: false,
      };
      // The server already has both messages, so the history page may contain the later
      // one before the earlier update has been applied.
      window.__televechaFixture!.setMessages([message]);
      window.__televechaFixture!.emit({
        type: 'new-message',
        pts: 11 + index,
        ptsCount: 1,
        message,
      });
    }
  });
  await expect(page.locator('article[data-message-id="81"]')).toBeVisible();
  await expect(page.locator('article[data-message-id="82"]')).toBeVisible();
});
