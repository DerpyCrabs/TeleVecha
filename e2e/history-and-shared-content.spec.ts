import { type Locator, type Page, test } from '@playwright/test';
import { expect } from './expect';

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

test('browses shared content, its viewers and jumps to the source message', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('opens the selected shared-content type directly with useful message context', async () => {
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
    await expect(
      shared.getByRole('button', { name: 'Download fixture-document.pdf' }),
    ).toBeVisible();
    expect((await fixtureStats(page))?.getSharedMedia).toBeGreaterThanOrEqual(3);
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Shared files' })).toHaveCount(0);
  await test.step('Escape closes only the topmost media viewer before its shared-media dialog', async () => {
    await page.getByRole('button', { name: /Photos.*128/ }).click();
    const shared = page.getByRole('dialog', { name: 'Shared photos' });
    const preview = shared.getByRole('button', { name: 'Open fixture.jpg fullscreen preview' });
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
  await test.step('navigates through the complete shared-photo result set', async () => {
    await page.getByRole('button', { name: /Photos.*128/ }).click();
    const shared = page.getByRole('dialog', { name: 'Shared photos' });
    await shared.getByRole('button', { name: 'Open old-fixture.jpg fullscreen preview' }).click();
    let viewer = page.getByRole('dialog', { name: 'Media preview: old-fixture.jpg' });
    await expect(viewer.getByRole('button', { name: 'Previous attachment' })).toBeEnabled();
    await viewer.getByRole('button', { name: 'Previous attachment' }).click();
    viewer = page.getByRole('dialog', { name: 'Media preview: fixture.jpg' });
    await expect(viewer).toBeVisible();
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /Media preview:/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Shared photos' })).toHaveCount(0);
  await test.step('shows a thumbnail in replies to media messages and jumps from shared media', async () => {
    const reply = page.locator('article[data-message-id="79"] .message-reply');
    await expect(reply.locator('img')).toBeVisible();
    await page.getByRole('button', { name: /Photos.*128/ }).click();
    await page.getByRole('button', { name: /Go to media message fixture.jpg from/ }).click();
    await expect(page.getByRole('dialog', { name: 'Shared photos' })).toHaveCount(0);
    await expect(page.locator('article[data-message-id="78"]')).toBeInViewport();
  });
  await test.step('loads and reveals old shared media outside the current history window', async () => {
    await page.getByRole('button', { name: /Photos.*128/ }).click();
    await page.getByRole('button', { name: /Go to media message old-fixture.jpg/ }).click();
    await expect(page.locator('article[data-message-id="5"]')).toBeInViewport();
    expect((await fixtureStats(page))?.getHistoryAround).toBe(1);
  });
});

for (const kind of ['photos', 'files', 'links'] as const) {
  test(`scrolling shared ${kind} loads every page`, async ({ page }) => {
    await openReady(page, '/?scenario=shared-media-pagination');
    await selectAlice(page);
    await page.getByRole('button', { name: new RegExp(`^${kind}`, 'iu') }).click();
    const shared = page.getByRole('dialog', { name: `Shared ${kind}` });
    const rows = shared.locator('article');
    await expect(rows).toHaveCount(100);
    expect((await fixtureStats(page))?.getSharedMedia).toBe(1);

    for (const count of [200, 205]) {
      await shared.locator('.shared-items').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(rows).toHaveCount(count);
    }
    await expect(shared.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
    expect((await fixtureStats(page))?.getSharedMedia).toBe(3);
  });
}

test('shared media fills the modal when successive pages do not overflow', async ({ page }) => {
  await openReady(page, '/?scenario=shared-media-short-pages');
  await selectAlice(page);
  await page.getByRole('button', { name: /^Photos/u }).click();
  const shared = page.getByRole('dialog', { name: 'Shared photos' });
  await expect(shared.locator('article')).toHaveCount(3);
  await expect(shared.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
  expect((await fixtureStats(page))?.getSharedMedia).toBe(3);
});

test('previews image documents directly from shared files with message actions', async ({
  page,
}) => {
  await openReady(page, '/?scenario=shared-image-document');
  await selectAlice(page);
  await page.getByRole('button', { name: /^Files/u }).click();
  const shared = page.getByRole('dialog', { name: 'Shared files' });
  await shared.getByRole('button', { name: 'Open shared-diagram.png fullscreen preview' }).click();
  const viewer = page.getByRole('dialog', { name: 'Media preview: shared-diagram.png' });
  await expect(viewer.getByRole('img', { name: 'shared-diagram.png' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Download shared-diagram.png' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Forward message' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Delete message' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Go to message' })).toBeVisible();
});

test('loads shared-video thumbnails without downloading the original file', async ({ page }) => {
  await openReady(page, '/?scenario=shared-video');
  await selectAlice(page);
  await expect(page.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  const before = await fixtureStats(page);

  await page.getByRole('button', { name: /^Videos/u }).click();
  const shared = page.getByRole('dialog', { name: 'Shared videos' });
  await expect(shared.getByRole('img', { name: 'shared-video.mp4' })).toBeVisible();
  await expect
    .poll(async () => (await fixtureStats(page))?.downloadMediaPreview ?? 0)
    .toBeGreaterThan(before?.downloadMediaPreview ?? 0);
  expect((await fixtureStats(page))?.downloadMediaFull).toBe(before?.downloadMediaFull ?? 0);

  await shared.getByRole('button', { name: 'Open shared-video.mp4 fullscreen preview' }).click();
  await expect(page.getByRole('dialog', { name: 'Media preview: shared-video.mp4' })).toBeVisible();
  await expect
    .poll(async () => (await fixtureStats(page))?.downloadMediaFull ?? 0)
    .toBe((before?.downloadMediaFull ?? 0) + 1);
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

test('loads all 1,000 messages page by page, only at the loaded boundary', async ({ page }) => {
  const resizeErrors: string[] = [];
  page.on('pageerror', (error) => {
    if (error.message.includes('ResizeObserver')) resizeErrors.push(error.message);
  });
  await page.goto('/?scenario=long-history');
  await page.getByRole('button', { name: /Long History/ }).click();
  const scroller = page.getByTestId('message-scroller');
  await expect(scroller.getByText('Long history message 1000', { exact: true })).toBeVisible();
  for (const expected of Array.from({ length: 19 }, (_, index) => (index + 2) * 50)) {
    await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      element.scrollTop = 0;
    });
    await expect.poll(() => loadedMessageCount(page)).toBeGreaterThanOrEqual(expected);
    await expectLoadedWindowRendered(scroller);
    if (expected !== 500) continue;
    // Away from the boundary, scrolling requests nothing.
    const historyRequests = (await fixtureStats(page))?.getHistory ?? 0;
    await scroller.evaluate((element) => {
      element.scrollTop = 100;
    });
    await page.waitForTimeout(100);
    expect((await fixtureStats(page))?.getHistory ?? 0).toBe(historyRequests);
    await expectLoadedWindowRendered(scroller);
  }
  expect(await loadedMessageCount(page)).toBe(1000);
  await expect(page.getByText('Long history message 1', { exact: true })).toBeAttached();
  await expectLoadedWindowRendered(scroller);
  expect(resizeErrors).toEqual([]);
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
