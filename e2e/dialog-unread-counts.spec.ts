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
    getComputedStyle(element).getPropertyValue('--unread-muted-bg').trim(),
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
  await page.screenshot({
    path: test.info().outputPath('chat-indicators-wide.png'),
    animations: 'disabled',
  });
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
  await page.screenshot({
    path: test.info().outputPath('chat-indicators-compact.png'),
    animations: 'disabled',
  });
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

for (const theme of ['night', 'tinted', 'day', 'classic']) {
  test(`muted unread digits remain readable in ${theme} theme`, async ({ page }) => {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
      window.__televechaFixture!.emit({ type: 'mute-changed', peerId: 'u:101', muted: true });
    }, theme);
    const row = chatButton(page, /Alice Fixture/);
    const badge = row.locator('.chat-unread-badge-trailing');
    const contrast = () =>
      badge.evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (color: string) => {
          const rgb = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              const s = v / 255;
              return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
          return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
        };
        const a = luminance(style.color),
          b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    await expect(badge).toHaveClass(/muted/);
    expect(await contrast()).toBeGreaterThanOrEqual(4.5);
    await row.hover();
    expect(await contrast()).toBeGreaterThanOrEqual(4.5);
    await row.evaluate((element) => element.setAttribute('aria-current', 'true'));
    expect(await contrast()).toBeGreaterThanOrEqual(4.5);
    await row.evaluate((element) => element.removeAttribute('aria-current'));
    await page.screenshot({
      path: test.info().outputPath(`muted-badge-${theme}.png`),
      animations: 'disabled',
    });
  });
}
