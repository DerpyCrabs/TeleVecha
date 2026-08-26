import { expect, test } from '@playwright/test';

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
  await expect(alice).toHaveAccessibleName(/2 unread messages, muted$/);

  await alice.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive chat' }).click();

  const archived = page.getByRole('button', { name: /Archived chats, 1 chat/ });
  await expect(archived.locator('.chat-unread-badge-trailing')).toHaveText('2');
  await expect(archived).toHaveAccessibleName('Archived chats, 1 chat, 2 unread messages');

  await archived.click();
  const archivedAlice = chatButton(page, /Alice Fixture/);
  await expect(archivedAlice.locator('.chat-unread-badge-trailing')).toHaveText('2');
  await expect(archivedAlice.locator('.chat-unread-badge-trailing')).toHaveClass(/muted/);

  const separator = page.getByRole('separator', { name: 'Resize chat list' });
  await separator.focus();
  await separator.press('Home');
  await expect(archivedAlice.locator('.chat-unread-badge-compact')).toBeVisible();
  await expect(archivedAlice.locator('.chat-unread-badge-compact')).toHaveText('2');
});
