import { expect, type Page } from '@playwright/test';

export async function openReady(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.getByTestId('chat-list')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Starting TeleVecha' })).toHaveCount(0);
  await expect(page.getByText('Fetching current chats')).toHaveCount(0);
  await expect(page.getByText('Connecting to Telegram')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const runtime = [...(window.__televechaRuntimes?.values() ?? [])][0];
        const snapshot = runtime?.engine.snapshot();
        return snapshot?.phase === 'ready' && snapshot.online;
      }),
    )
    .toBe(true);
}

export function chatButton(page: Page, name: RegExp) {
  return page.getByTestId('chat-list').getByRole('button', { name });
}

export async function selectAlice(page: Page) {
  const alice = chatButton(page, /Alice Fixture/);
  await expect(alice).toBeVisible();
  await alice.click();
  await expect(
    page.getByTestId('message-scroller').getByText('Newest message from fixture'),
  ).toBeVisible();
}

export async function fixtureStats(page: Page) {
  return page.evaluate(() => window.__televechaFixture?.stats);
}
