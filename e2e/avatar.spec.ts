import { test } from '@playwright/test';
import { expect } from './expect';
import { chatButton, openReady, selectAlice } from './helpers';

test('moving the pointer while pressing a compact chat avatar does not start a native drag', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('televecha:left-sidebar-width', '72');
  });
  await openReady(page);
  await selectAlice(page);
  const release = chatButton(page, /Release Channel/);
  const avatar = release.locator('img');
  await expect(avatar).toBeVisible();
  await release.evaluate((element) => {
    element.addEventListener('dragstart', (event) => {
      element.setAttribute('data-native-drag-started', 'true');
      // Record the regression without entering the platform drag loop in the test.
      event.preventDefault();
    });
  });
  const bounds = await avatar.boundingBox();
  if (!bounds) throw new Error('Chat avatar is not visible');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 12, bounds.y + bounds.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(release).not.toHaveAttribute('data-native-drag-started', 'true');
  await release.click();
  await expect(page.getByTestId('conversation-header')).toContainText('Release Channel');
  await selectAlice(page);
  await page.getByRole('textbox', { name: 'Message' }).fill('Still interactive');
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Still interactive');
  const scroller = page.getByTestId('message-scroller');
  await scroller.hover();
  await page.mouse.wheel(0, -200);
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeGreaterThan(100);
});

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
