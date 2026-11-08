import { test } from '@playwright/test';
import { expect } from './expect';

import { chatButton, openReady } from './helpers';

test.beforeEach(async ({ page }) => {
  await openReady(page);
});

test('keeps unread counts visible and accessible across dialog views', async ({ page }) => {
  const alice = chatButton(page, /Alice Fixture/);
  const trailingBadge = alice.locator('.chat-unread-badge-trailing');

  await expect(trailingBadge).toHaveText('2');
  await expect(alice).toHaveAccessibleName(/Alice Fixture, .*2 unread messages/);

  const search = page.getByRole('textbox', { name: 'Search chats' });
  await search.fill('Alice Fixture');
  await expect(alice.locator('.chat-unread-badge-trailing')).toHaveText('2');
  await search.clear();

  await alice.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mute' }).click();
  await expect(alice.locator('.chat-unread-badge-trailing')).toHaveClass(/muted/);
  const mutedColor = await alice.evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--muted').trim(),
  );
  await expect(alice.locator('.chat-unread-badge-trailing')).toHaveCSS(
    'background-color',
    await page.evaluate((color) => {
      const el = document.createElement('span');
      el.style.color = color;
      document.body.append(el);
      const rgb = getComputedStyle(el).color;
      el.remove();
      return rgb;
    }, mutedColor),
  );
  await expect(alice.locator('.chat-muted-icon')).toHaveCSS('width', '12px');
  await expect(alice.locator('.chat-muted-icon')).toHaveCSS('height', '12px');
  await expect(alice).toHaveAccessibleName(/2 unread messages, muted$/);

  await alice.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive chat' }).click();

  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  const archivedAlice = chatButton(page, /Alice Fixture/);
  await expect(archivedAlice.locator('.chat-unread-badge-trailing')).toHaveText('2');
  await expect(archivedAlice.locator('.chat-unread-badge-trailing')).toHaveClass(/muted/);

  const separator = page.getByRole('separator', { name: 'Resize chat list' });
  await separator.focus();
  await separator.press('Home');
  const compactBadge = archivedAlice.locator('.chat-unread-badge-compact');
  await expect(compactBadge).toBeVisible();
  await expect(compactBadge).toHaveText('2');
  await expect(compactBadge).toHaveClass(/muted/);
  await expect
    .poll(async () => {
      const box = await compactBadge.boundingBox();
      return box ? Math.min(box.width, box.height) : 0;
    })
    .toBeGreaterThanOrEqual(24);
});

test('publishes the total unread count to the application badge', async ({ page }) => {
  await page.addInitScript(() => {
    const values: number[] = [];
    Object.defineProperty(window, '__badgeValues', { configurable: true, value: values });
    Object.defineProperty(navigator, 'setAppBadge', {
      configurable: true,
      value: async (count?: number) => {
        values.push(count ?? 0);
      },
    });
    Object.defineProperty(navigator, 'clearAppBadge', {
      configurable: true,
      value: async () => {
        values.push(0);
      },
    });
  });
  await page.reload();
  await expect(page.getByTestId('chat-list')).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const values = (window as Window & { __badgeValues?: number[] }).__badgeValues ?? [];
        return values.at(-1) ?? 0;
      }),
    )
    .toBeGreaterThan(0);
});

test('shows mention and reaction badges beside unread counts in wide and compact chat lists', async ({
  page,
}) => {
  await page.evaluate(() => {
    const snapshot = [...window.__televechaRuntimes!.values()][0]!.engine.snapshot();
    const dialog = snapshot.dialogs.find(({ peer }) => peer.id === 'u:101')!;
    window.__televechaFixture!.emit({
      type: 'dialog-changed',
      dialog: { ...dialog, muted: true, unreadMentionsCount: 2, unreadReactionsCount: 3 },
    });
  });
  const alice = chatButton(page, /Alice Fixture/);
  await expect(alice.locator('.chat-attention-badge')).toHaveCount(2);
  await expect(alice.locator('[title="2 unread replies and mentions"]')).toBeVisible();
  await expect(alice.locator('[title="3 unread reactions"]')).toBeVisible();
  await expect(alice.locator('.chat-unread-badge-trailing')).toHaveClass(/muted/);
  await page.screenshot({ path: '/tmp/chat-indicators-wide.png', animations: 'disabled' });
  await page.getByRole('separator', { name: 'Resize chat list' }).focus();
  await page.getByRole('separator', { name: 'Resize chat list' }).press('Home');
  const compact = alice.locator('.chat-attention-badges-compact');
  await expect(compact.locator('.chat-attention-badge')).toHaveCount(2);
  await expect(compact).toBeVisible();
  const positions = await alice.evaluate((element) => {
    const badges = element.querySelector('.chat-attention-badges-compact')!.getBoundingClientRect();
    const unread = element.querySelector('.chat-unread-badge-compact')!.getBoundingClientRect();
    return badges.top >= unread.bottom;
  });
  expect(positions).toBe(true);
  await page.screenshot({ path: '/tmp/chat-indicators-compact.png', animations: 'disabled' });
  await page.evaluate(() => {
    const dialog = [...window.__televechaRuntimes!.values()][0]!.engine
      .snapshot()
      .dialogs.find(({ peer }) => peer.id === 'u:101')!;
    window.__televechaFixture!.emit({
      type: 'dialog-changed',
      dialog: { ...dialog, unreadMentionsCount: 0, unreadReactionsCount: 0 },
    });
  });
  await expect(alice.locator('.chat-attention-badge')).toHaveCount(0);
});
