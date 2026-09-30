import { type Page } from '@playwright/test';
import { expect } from './expect';

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

/** Release a held connection once the application has actually asked to connect. */
export async function releaseHeldConnect(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.__televechaFixture?.stats.connect ?? 0))
    .toBeGreaterThan(0);
  await page.evaluate(() => window.__televechaFixture?.releaseConnect());
}

/** Wait until a fixture counter has stopped changing, so later counts start from rest. */
export async function counterSettled(page: Page, read: () => Promise<number>) {
  let previous = await read();
  await expect
    .poll(
      async () => {
        const last = previous;
        previous = await read();
        return previous === last;
      },
      { intervals: [200] },
    )
    .toBe(true);
}
