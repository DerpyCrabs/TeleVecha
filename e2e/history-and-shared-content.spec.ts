import { expect, type Locator, test } from '@playwright/test';

import { fixtureStats, openReady, selectAlice } from './helpers';

async function waitForScrollToSettle(scroller: Locator) {
  await scroller.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        let previous = element.scrollTop;
        let stableFrames = 0;
        const check = () => {
          const current = element.scrollTop;
          stableFrames = Math.abs(current - previous) < 0.5 ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 3) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
  );
}

test.beforeEach(async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
});

test('opens the selected shared-content type directly with useful message context', async ({
  page,
}) => {
  await page.getByRole('button', { name: /Media.*128/ }).click();
  let shared = page.getByRole('dialog', { name: 'Shared media' });
  await expect(shared.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  await expect(shared.getByRole('tablist')).toHaveCount(0);
  await expect(shared.locator('.shared-media-tile').first()).toHaveCSS('min-height', '144px');
  await expect(shared.getByRole('button', { name: /Go to media message/ }).first()).toBeVisible();
  await shared.getByRole('button', { name: /Close shared media/ }).click();

  await page.getByRole('button', { name: /Links.*44/ }).click();
  shared = page.getByRole('dialog', { name: 'Shared links' });
  await expect(shared.getByRole('link', { name: /example.com/ }).first()).toBeVisible();
  await expect(shared.locator('time').first()).toBeVisible();
  await shared.getByRole('button', { name: /Close shared links/ }).click();

  await page.getByRole('button', { name: /Files.*16/ }).click();
  shared = page.getByRole('dialog', { name: 'Shared files' });
  await expect(shared.getByText('fixture-document.pdf')).toBeVisible();
  await expect(shared.getByText(/41 KB.*application\/pdf/)).toBeVisible();
  expect((await fixtureStats(page))?.getSharedMedia).toBeGreaterThanOrEqual(3);
});

test('Escape closes only the topmost media viewer before its shared-media dialog', async ({
  page,
}) => {
  await page.getByRole('button', { name: /Media.*128/ }).click();
  const shared = page.getByRole('dialog', { name: 'Shared media' });
  const preview = shared.getByRole('button', {
    name: 'Open fixture.jpg fullscreen preview',
  });
  await preview.click();
  const viewer = page.getByRole('dialog', { name: 'Media preview: fixture.jpg' });
  await expect(viewer).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(shared).toBeVisible();
  await expect(preview).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(shared).toHaveCount(0);
});

test('shows a thumbnail in replies to media messages and jumps from shared media', async ({
  page,
}) => {
  const reply = page.locator('article[data-message-id="79"] .message-reply');
  await expect(reply.locator('img')).toBeVisible();
  await page.getByRole('button', { name: /Media.*128/ }).click();
  await page.getByRole('button', { name: /Go to media message fixture.jpg from/ }).click();
  await expect(page.getByRole('dialog', { name: 'Shared media' })).toHaveCount(0);
  await expect(page.locator('article[data-message-id="78"]')).toBeInViewport();
});

test('loads and reveals old shared media outside the current history window', async ({ page }) => {
  await page.getByRole('button', { name: /Media.*128/ }).click();
  await page.getByRole('button', { name: /Go to media message old-fixture.jpg/ }).click();
  await expect(page.locator('article[data-message-id="5"]')).toBeInViewport();
  expect((await fixtureStats(page))?.getHistoryAround).toBe(1);
});

test('a slow message jump cannot take over a newer chat selection', async ({ page }) => {
  await page.goto('/?scenario=held-history-around');
  await selectAlice(page);
  await page.getByRole('button', { name: /Media.*128/ }).click();
  await page.getByRole('button', { name: /Go to media message old-fixture.jpg/ }).click();
  await expect.poll(async () => (await fixtureStats(page))?.getHistoryAround ?? 0).toBe(1);

  await page.getByRole('button', { name: /Release Channel/ }).click();
  await expect(page.locator('.chat-header')).toContainText('Release Channel');
  await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready');

  await page.evaluate(() => window.__televechaFixture?.releaseHistoryAround());
  await page.waitForTimeout(100);
  await expect(page.locator('.chat-header')).toContainText('Release Channel');
  await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready');
  await expect(page.locator('article[data-message-id="5"]')).not.toContainText('Fixture message 5');
});

test('shows and incrementally fills a real gap after jumping far back in history', async ({
  page,
}) => {
  await page.goto('/?scenario=long-history');
  await page.getByRole('button', { name: /Long History/ }).click();
  await page.getByRole('button', { name: 'Search messages' }).click();
  const search = page.getByRole('dialog', { name: 'Message search' });
  const query = search.getByRole('textbox', { name: 'Message search query' });
  await query.fill('Long history message 100');
  await query.press('Enter');
  await search
    .getByRole('button', { name: 'Long History Long history message 100', exact: true })
    .click();

  const target = page.locator('article[data-message-id="100"]');
  await expect(target).toBeInViewport();
  const gap = page.getByRole('button', { name: 'Load missing messages' });
  const scroller = page.getByTestId('message-scroller');
  await expect(gap).toBeVisible();
  await scroller.dispatchEvent('wheel', { deltaY: -1 });
  await gap.scrollIntoViewIfNeeded();
  await waitForScrollToSettle(scroller);
  const anchor = await scroller.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const message = [...element.querySelectorAll<HTMLElement>('article.message')].find(
      (candidate) => candidate.getBoundingClientRect().bottom >= top,
    );
    if (!message?.dataset.messageId) throw new Error('Visible gap anchor is missing');
    return { id: message.dataset.messageId, top: message.getBoundingClientRect().top };
  });
  const historyCalls = (await fixtureStats(page))?.getHistory ?? 0;

  await gap.click();

  await expect
    .poll(async () => (await fixtureStats(page))?.getHistory ?? 0)
    .toBeGreaterThan(historyCalls);
  await expect(gap).toBeVisible();
  const sameAnchor = page.locator(`article[data-message-id="${anchor.id}"]`);
  await expect
    .poll(async () =>
      Math.abs(
        (await sameAnchor.evaluate((element) => element.getBoundingClientRect().top)) - anchor.top,
      ),
    )
    .toBeLessThan(4);
});

test('loads all 1,000 messages while capping the DOM and preserving navigation', async ({
  page,
}) => {
  await page.goto('/?scenario=long-history');
  await page.getByRole('button', { name: /Long History/ }).click();
  const scroller = page.getByTestId('message-scroller');
  await expect(scroller.getByText('Long history message 1000', { exact: true })).toBeVisible();
  for (const expected of Array.from({ length: 19 }, (_, index) => (index + 2) * 50)) {
    const anchor = await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      element.scrollTop = 100;
      const top = element.getBoundingClientRect().top;
      const message = [...element.querySelectorAll<HTMLElement>('article.message')].find(
        (candidate) => candidate.getBoundingClientRect().bottom >= top,
      );
      if (!message?.dataset.messageId) throw new Error('Visible history anchor is missing');
      return { id: message.dataset.messageId, top: message.getBoundingClientRect().top };
    });
    await expect(
      scroller.getByText(`Long history message ${1001 - expected}`, { exact: true }),
    ).toBeAttached();
    await expect(page.locator('article.message')).toHaveCount(Math.min(expected, 400));
    const sameAnchor = page.locator(`article[data-message-id="${anchor.id}"]`);
    await expect
      .poll(async () =>
        Math.abs(
          (await sameAnchor.evaluate((element) => element.getBoundingClientRect().top)) -
            anchor.top,
        ),
      )
      .toBeLessThan(4);
  }
  await expect(page.getByText('Long history message 1', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'Show newer loaded messages' }).click();
  await expect(page.getByText('Long history message 500', { exact: true })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Show earlier loaded messages' })).toBeVisible();
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const jump = page.getByRole('button', { name: 'Jump to present' });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(scroller.getByText('Long history message 1000', { exact: true })).toBeVisible();
  await expect(page.getByText('Long history message 1', { exact: true })).not.toBeAttached();
  await expect(page.locator('article.message')).toHaveCount(400);
});

test('traverses an earlier cached message window before requesting more history', async ({
  page,
}) => {
  await page.goto('/?scenario=long-history');
  await page.getByRole('button', { name: /Long History/ }).click();
  const scroller = page.getByTestId('message-scroller');
  await expect(scroller.getByText('Long history message 1000', { exact: true })).toBeVisible();
  for (const oldestId of [901, 851, 801, 751, 701, 651, 601, 551, 501]) {
    await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      element.scrollTop = 100;
    });
    await expect(
      scroller.getByText(`Long history message ${oldestId}`, { exact: true }),
    ).toBeAttached();
  }
  await page.getByRole('button', { name: 'Show newer loaded messages' }).click();
  await expect(scroller.getByText('Long history message 501', { exact: true })).not.toBeAttached();
  const historyRequests = (await fixtureStats(page))?.getHistory;

  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    element.scrollTop = 100;
  });

  await expect(scroller.getByText('Long history message 501', { exact: true })).toBeAttached();
  await expect.poll(async () => (await fixtureStats(page))?.getHistory).toBe(historyRequests);
});

test('continues cached history after reloading the remembered chat', async ({ page }) => {
  await page.goto('/?scenario=long-history');
  await page.getByRole('button', { name: /Long History/ }).click();
  await expect(
    page.getByTestId('message-scroller').getByText('Long history message 1000', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('article.message')).toHaveCount(50);

  await page.reload();
  await expect(
    page.getByTestId('message-scroller').getByText('Long history message 1000', { exact: true }),
  ).toBeVisible();
  expect((await fixtureStats(page))?.getHistory).toBe(0);

  const reloadedScroller = page.getByTestId('message-scroller');
  await reloadedScroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    element.scrollTop = 0;
  });

  await expect.poll(async () => (await fixtureStats(page))?.getHistory).toBeGreaterThanOrEqual(1);
  await expect.poll(() => page.locator('article.message').count()).toBeGreaterThanOrEqual(100);
  await expect.poll(() => page.locator('article.message').count()).toBeLessThanOrEqual(400);
  await expect(page.getByText('Long history message 901', { exact: true })).toBeAttached();
});

test('preserves the visible message when an upward wheel loads older history', async ({ page }) => {
  await page.goto('/?scenario=long-history');
  await page.getByRole('button', { name: /Long History/ }).click();
  const scroller = page.getByTestId('message-scroller');
  await expect(scroller.locator('article.message')).toHaveCount(50);

  const anchor = await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -600 }));
    element.scrollTop = 0;
    const message = element.querySelector<HTMLElement>('article.message');
    if (!message?.dataset.messageId) throw new Error('Top message anchor is missing');
    return { id: message.dataset.messageId, top: message.getBoundingClientRect().top };
  });

  await expect.poll(() => scroller.locator('article.message').count()).toBeGreaterThan(50);
  const anchorAfter = scroller.locator(`article[data-message-id="${anchor.id}"]`);
  await expect
    .poll(async () =>
      Math.abs(
        (await anchorAfter.evaluate((element) => element.getBoundingClientRect().top)) - anchor.top,
      ),
    )
    .toBeLessThan(3);
});

test('keeps the viewport anchored while delayed older media finishes layout', async ({ page }) => {
  await page.goto('/?scenario=delayed-history-media');
  await page.getByRole('button', { name: /Long History/ }).click();
  const scroller = page.getByTestId('message-scroller');
  await expect(scroller.locator('article.message')).toHaveCount(50);

  const anchor = await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -600 }));
    element.scrollTop = 0;
    const message = element.querySelector<HTMLElement>('article.message');
    if (!message?.dataset.messageId) throw new Error('Top message anchor is missing');
    return { id: message.dataset.messageId, top: message.getBoundingClientRect().top };
  });

  await expect.poll(() => scroller.locator('article.message').count()).toBeGreaterThan(50);
  const delayedMedia = page.locator('article[data-message-id="925"]');
  await expect(delayedMedia).toBeAttached();
  await expect(page.getByRole('img', { name: 'delayed-history-layout.tgs' })).toHaveCount(0);
  await page.waitForTimeout(100);
  const anchorAfter = scroller.locator(`article[data-message-id="${anchor.id}"]`);
  expect(
    Math.abs(
      (await anchorAfter.evaluate((element) => element.getBoundingClientRect().top)) - anchor.top,
    ),
  ).toBeLessThan(3);

  await page.locator('article[data-message-id="925"]').evaluate((element) => {
    element.style.minHeight = '240px';
  });
  await expect
    .poll(async () =>
      Math.abs(
        (await anchorAfter.evaluate((element) => element.getBoundingClientRect().top)) - anchor.top,
      ),
    )
    .toBeLessThan(3);

  await scroller.dispatchEvent('wheel', { deltaY: -1 });
  await delayedMedia.scrollIntoViewIfNeeded();
  await expect(page.getByRole('img', { name: 'delayed-history-layout.tgs' })).toBeVisible();
});
