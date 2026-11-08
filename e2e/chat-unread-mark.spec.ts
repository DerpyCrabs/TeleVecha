import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, chatButton } from './helpers';

test('manual unread mark is a dot, clears when reopened', async ({ page }) => {
  await openReady(page, '/?chat=u%3A101');
  const alice = chatButton(page, /Alice Fixture/);
  await expect(
    page.getByTestId('message-scroller').getByText('Newest message from fixture'),
  ).toBeVisible();
  await alice.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mark as unread', exact: true }).click();
  await expect(alice.locator('.chat-unread-badge')).toHaveText('•');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...window.__televechaRuntimes!.values()][0]!.engine
            .snapshot()
            .dialogs.find((d) => d.peer.id === 'u:101')?.unreadCount,
      ),
    )
    .toBe(0);
  await page.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect(alice).toBeVisible();
  await alice.click();
  await expect(alice).toHaveCount(0);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await alice.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mark as unread', exact: true }).click();
  await expect(alice.locator('.chat-unread-badge')).toHaveText('•');
  await alice.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mark as read', exact: true }).click();
  await expect(alice.locator('.chat-unread-badge')).toHaveCount(0);
});
