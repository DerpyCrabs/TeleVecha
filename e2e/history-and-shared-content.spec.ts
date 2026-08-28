import { expect, type Locator, type Page, test } from '@playwright/test';

import { chatButton, fixtureStats, openReady, selectAlice } from './helpers';

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

async function expectLoadedWindowRendered(scroller: Locator) {
  await expect.poll(() => scroller.locator('article.message').count()).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const page = scroller.page();
      return (await loadedMessageCount(page)) - (await scroller.locator('article.message').count());
    })
    .toBe(0);
}

async function loadedMessageCount(page: Page) {
  return page.evaluate(() => {
    const runtime = [...(window.__televechaRuntimes?.values() ?? [])][0];
    return runtime?.engine.snapshot().messages.length ?? 0;
  });
}

async function startHistoryAnchorSampling(scroller: Locator) {
  return scroller.evaluate(
    (element) =>
      new Promise<{ id: string; top: number }>((resolve, reject) => {
        element.addEventListener(
          'scroll',
          () => {
            const viewportTop = element.getBoundingClientRect().top;
            const message = [...element.querySelectorAll<HTMLElement>('article.message')].find(
              (candidate) => candidate.getBoundingClientRect().bottom >= viewportTop,
            );
            if (!message?.dataset.messageId) {
              reject(new Error('Visible history anchor is missing'));
              return;
            }
            const anchor = {
              id: message.dataset.messageId,
              top: message.getBoundingClientRect().top,
            };
            const frameOffsets: number[] = [];
            let missingFrames = 0;
            let sampling = true;
            const sample = () => {
              if (!sampling) return;
              const current = element.querySelector<HTMLElement>(
                `article[data-message-id="${CSS.escape(anchor.id)}"]`,
              );
              if (current) frameOffsets.push(current.getBoundingClientRect().top - anchor.top);
              else missingFrames += 1;
              requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
            Object.assign(window, {
              __historyAnchorFrames: frameOffsets,
              __historyAnchorMissingFrames: () => missingFrames,
              __stopHistoryAnchorFrames: () => {
                sampling = false;
              },
            });
            resolve(anchor);
          },
          { once: true },
        );
        element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -600 }));
        element.scrollTop = 0;
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
  await page.getByRole('button', { name: /Photos.*128/ }).click();
  let shared = page.getByRole('dialog', { name: 'Shared photos' });
  await expect(shared.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  await expect(shared.getByRole('tablist')).toHaveCount(0);
  await expect(shared.locator('.shared-media-tile').first()).toHaveCSS('min-height', '144px');
  await expect(shared.getByRole('button', { name: /Go to media message/ }).first()).toBeVisible();
  await shared.getByRole('button', { name: /Close shared photos/ }).click();

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
  await page.getByRole('button', { name: /Photos.*128/ }).click();
  const shared = page.getByRole('dialog', { name: 'Shared photos' });
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
  await page.getByRole('button', { name: /Photos.*128/ }).click();
  await page.getByRole('button', { name: /Go to media message fixture.jpg from/ }).click();
  await expect(page.getByRole('dialog', { name: 'Shared photos' })).toHaveCount(0);
  await expect(page.locator('article[data-message-id="78"]')).toBeInViewport();
});

test('loads and reveals old shared media outside the current history window', async ({ page }) => {
  await page.getByRole('button', { name: /Photos.*128/ }).click();
  await page.getByRole('button', { name: /Go to media message old-fixture.jpg/ }).click();
  await expect(page.locator('article[data-message-id="5"]')).toBeInViewport();
  expect((await fixtureStats(page))?.getHistoryAround).toBe(1);
});

test('a slow message jump cannot take over a newer chat selection', async ({ page }) => {
  await page.goto('/?scenario=held-history-around');
  await selectAlice(page);
  await page.getByRole('button', { name: /Photos.*128/ }).click();
  await page.getByRole('button', { name: /Go to media message old-fixture.jpg/ }).click();
  await expect.poll(async () => (await fixtureStats(page))?.getHistoryAround ?? 0).toBe(1);

  await chatButton(page, /Release Channel/).click();
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

test('loads all 1,000 messages only as the user reaches each older page', async ({ page }) => {
  await page.goto('/?scenario=long-history');
  await page.getByRole('button', { name: /Long History/ }).click();
  const scroller = page.getByTestId('message-scroller');
  await expect(scroller.getByText('Long history message 1000', { exact: true })).toBeVisible();
  await expect(scroller.getByText('Long history message 1000', { exact: true })).toBeVisible();
  for (const expected of Array.from({ length: 19 }, (_, index) => (index + 2) * 50)) {
    await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      element.scrollTop = 0;
    });
    await expect.poll(() => loadedMessageCount(page)).toBeGreaterThanOrEqual(expected);
    await expectLoadedWindowRendered(scroller);
  }
  expect(await loadedMessageCount(page)).toBe(1000);
  await expect(page.getByText('Long history message 1', { exact: true })).toBeAttached();
  await expectLoadedWindowRendered(scroller);
});

test('full message flow does not produce ResizeObserver loop errors', async ({ page }) => {
  const resizeErrors: string[] = [];
  page.on('pageerror', (error) => {
    if (error.message.includes('ResizeObserver')) resizeErrors.push(error.message);
  });
  await page.goto('/?scenario=long-history');
  await page.getByRole('button', { name: /Long History/ }).click();
  const scroller = page.getByTestId('message-scroller');
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
    await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      element.scrollTop = 0;
    });
    await expect.poll(() => loadedMessageCount(page)).toBeGreaterThanOrEqual(100 + pageIndex * 50);
    await expectLoadedWindowRendered(scroller);
  }
  expect(resizeErrors).toEqual([]);
});

test('loads earlier history only when the viewport reaches the exact loaded boundary', async ({
  page,
}) => {
  await page.goto('/?scenario=long-history');
  await page.getByRole('button', { name: /Long History/ }).click();
  const scroller = page.getByTestId('message-scroller');
  await expect(scroller.getByText('Long history message 1000', { exact: true })).toBeVisible();
  for (const expectedCount of [100, 150, 200, 250, 300, 350, 400, 450, 500]) {
    await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      element.scrollTop = 0;
    });
    await expect.poll(() => loadedMessageCount(page)).toBeGreaterThanOrEqual(expectedCount);
    await expectLoadedWindowRendered(scroller);
  }
  const historyRequests = (await fixtureStats(page))?.getHistory ?? 0;

  await scroller.evaluate((element) => {
    element.scrollTop = 100;
  });
  await page.waitForTimeout(100);
  expect((await fixtureStats(page))?.getHistory ?? 0).toBe(historyRequests);
  await expectLoadedWindowRendered(scroller);
});

test('continues cached history after reloading the remembered chat', async ({ page }) => {
  await page.goto('/?scenario=long-history');
  await page.getByRole('button', { name: /Long History/ }).click();
  await expect(
    page.getByTestId('message-scroller').getByText('Long history message 1000', { exact: true }),
  ).toBeVisible();
  await expectLoadedWindowRendered(page.getByTestId('message-scroller'));
  await page.getByTestId('message-scroller').evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    element.scrollTop = 0;
  });
  await expect.poll(() => loadedMessageCount(page)).toBe(100);

  await page.reload();
  await expect(
    page.getByTestId('message-scroller').getByText('Long history message 1000', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('article.message')).toHaveCount(50);
  expect((await fixtureStats(page))?.getHistory).toBe(0);

  const reloadedScroller = page.getByTestId('message-scroller');
  await reloadedScroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    element.scrollTop = 0;
  });

  await expect.poll(() => loadedMessageCount(page)).toBeGreaterThanOrEqual(100);
  expect((await fixtureStats(page))?.getHistory).toBe(0);
  await expect(page.locator('article.message')).toHaveCount(100);
  await expectLoadedWindowRendered(reloadedScroller);
});

test('preserves the visible message when an upward wheel loads older history', async ({ page }) => {
  await page.goto('/?scenario=long-history');
  await page.getByRole('button', { name: /Long History/ }).click();
  const scroller = page.getByTestId('message-scroller');
  await expectLoadedWindowRendered(scroller);

  const anchor = await startHistoryAnchorSampling(scroller);

  await expect.poll(() => loadedMessageCount(page)).toBeGreaterThanOrEqual(100);
  await expectLoadedWindowRendered(scroller);
  const anchorAfter = scroller.locator(`article[data-message-id="${anchor.id}"]`);
  await expect
    .poll(async () =>
      Math.abs(
        (await anchorAfter.evaluate((element) => element.getBoundingClientRect().top)) - anchor.top,
      ),
    )
    .toBeLessThan(3);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const frameOffsets = await page.evaluate(() => {
    const tracked = window as unknown as {
      __historyAnchorFrames: number[];
      __historyAnchorMissingFrames: () => number;
      __stopHistoryAnchorFrames: () => void;
    };
    tracked.__stopHistoryAnchorFrames();
    return {
      offsets: tracked.__historyAnchorFrames,
      missingFrames: tracked.__historyAnchorMissingFrames(),
    };
  });
  expect(frameOffsets.offsets.length).toBeGreaterThan(0);
  expect(frameOffsets.missingFrames).toBe(0);
  expect(Math.max(...frameOffsets.offsets.map(Math.abs))).toBeLessThan(3);
});

test('keeps the viewport anchored while delayed older media finishes layout', async ({ page }) => {
  await page.goto('/?scenario=delayed-history-media');
  await page.getByRole('button', { name: /Long History/ }).click();
  const scroller = page.getByTestId('message-scroller');
  await expectLoadedWindowRendered(scroller);

  const anchor = await startHistoryAnchorSampling(scroller);

  await expect.poll(() => loadedMessageCount(page)).toBeGreaterThanOrEqual(100);
  await expectLoadedWindowRendered(scroller);
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
