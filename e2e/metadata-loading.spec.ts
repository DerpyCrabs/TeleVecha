import { expect, test } from '@playwright/test';
import { openReady, selectAlice } from './helpers';

test('shows chat history and shared-media counts while pinned loading is stalled', async ({
  page,
}) => {
  await openReady(page, '/?scenario=held-pins&chat=u%3A101');
  await expect(
    page.getByTestId('message-scroller').getByText('Newest message from fixture'),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const snapshot = [...window.__televechaRuntimes!.values()][0]!.engine.snapshot();
        return {
          loaded: !snapshot.loadingMessages && snapshot.messages.length > 0,
          counts: snapshot.sharedMediaCounts !== undefined,
          pinsRequested: window.__televechaFixture!.stats.getPinnedMessages > 0,
        };
      }),
    )
    .toEqual({ loaded: true, counts: true, pinsRequested: true });
  await expect(page.locator('.operation-state-banner')).toHaveCount(0);
});

test('keeps pinned refresh failures out of the chat and backs off repeated visits', async ({
  page,
}) => {
  await openReady(page, '/?scenario=failed-pins&chat=u%3A101');
  await expect(
    page.getByTestId('message-scroller').getByText('Newest message from fixture'),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__televechaFixture!.stats.getPinnedMessages))
    .toBe(1);
  for (let visit = 0; visit < 3; visit++) {
    await page
      .getByTestId('chat-list')
      .getByRole('button', { name: /Release Channel/ })
      .click();
    await selectAlice(page);
  }
  expect(await page.evaluate(() => window.__televechaFixture!.stats.getPinnedMessages)).toBe(2);
  const snapshot = await page.evaluate(() => {
    const snapshot = [...window.__televechaRuntimes!.values()][0]!.engine.snapshot();
    return { online: snapshot.online, sync: snapshot.sync, error: snapshot.operationError ?? '' };
  });
  expect(snapshot).toEqual({ online: true, sync: 'current', error: '' });
  await expect(page.locator('.operation-state-banner')).toHaveCount(0);
});
