import { expect, test } from '@playwright/test';

test('clears reused avatars immediately when the next chat avatar stalls and fails', async ({
  page,
}) => {
  await page.goto('/');
  const chatList = page.getByTestId('chat-list');
  const alice = chatList.getByRole('button', { name: /Alice Fixture/ });
  await expect(alice).toBeVisible();
  await alice.click();
  await expect(
    page.getByTestId('message-scroller').getByText('Newest message from fixture'),
  ).toBeVisible();

  const headerAvatar = page.getByTestId('conversation-header').locator('img');
  const detailsAvatar = page.getByTestId('details-avatar').locator('img');
  await expect(headerAvatar).toBeVisible();
  await expect(detailsAvatar).toBeVisible();

  const release = chatList.getByRole('button', { name: /Release Channel/ });
  await expect(release.locator('img')).toBeVisible();
  await page.evaluate(() => window.__televechaFixture?.changeAndHoldReleaseAvatar());
  await release.click();

  await expect(page.getByTestId('conversation-header')).toContainText('Release Channel');
  await expect(headerAvatar).toHaveCount(0);
  await expect(detailsAvatar).toHaveCount(0);

  await page.evaluate(() => window.__televechaFixture?.failPendingAvatar());
  await expect
    .poll(() => page.evaluate(() => window.__televechaFixture?.stats.releaseAvatarDownload))
    .toBeGreaterThanOrEqual(3);
  await expect(headerAvatar).toHaveCount(0);
  await expect(detailsAvatar).toHaveCount(0);
});
