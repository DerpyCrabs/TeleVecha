import { expect, test, type Page } from '@playwright/test';

import { chatButton, fixtureStats } from './helpers';

const CACHE_SCENARIO = 'held-connect+multiple-pins';
const CACHE_PATH = `/?scenario=${encodeURIComponent(CACHE_SCENARIO)}&chat=u%3A101`;

async function waitForRuntime(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean(window.__televechaFixture))).toBe(true);
}

async function waitForCachedWorkspace(page: Page, scenario = CACHE_SCENARIO) {
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const snapshot = window.__televechaRuntimes?.get(key)?.engine.snapshot();
        return {
          dialogs: snapshot?.dialogs.length ?? 0,
          online: snapshot?.online ?? false,
          phase: snapshot?.phase,
        };
      }, `fixture:${scenario}`),
    )
    .toEqual({ dialogs: 3, online: false, phase: 'connecting' });
}

async function releaseConnectionAndWaitUntilReady(page: Page, scenario = CACHE_SCENARIO) {
  await waitForRuntime(page);
  await expect
    .poll(() => fixtureStats(page).then((stats) => stats?.connect ?? 0))
    .toBeGreaterThanOrEqual(1);
  await page.evaluate(() => window.__televechaFixture?.releaseConnect());
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const snapshot = window.__televechaRuntimes?.get(key)?.engine.snapshot();
        return snapshot?.phase === 'ready' && snapshot.online && snapshot.sync === 'current';
      }, `fixture:${scenario}`),
    )
    .toBe(true);
}

async function expectAssignedChatBackground(page: Page) {
  const shell = page.locator('.message-scroll-shell');
  await expect(shell).toHaveAttribute('data-chat-theme', 'telegram');
  await expect(shell).toHaveAttribute('data-chat-wallpaper', 'telegram');
  await expect(shell).toHaveAttribute('data-chat-pattern', 'inverted');
  await expect
    .poll(() =>
      shell.evaluate((element) => element.style.getPropertyValue('--chat-wallpaper-asset')),
    )
    .toMatch(/^url\("blob:/u);
}

test('restores pinned messages from cache before Telegram reconnects', async ({ page }) => {
  await page.goto(CACHE_PATH);
  await releaseConnectionAndWaitUntilReady(page);
  await expect(
    page.getByRole('button', { name: /Pinned message 1 of 2.*Fixture message 79/ }),
  ).toBeVisible();
  await expect.poll(() => fixtureStats(page).then((stats) => stats?.getPinnedMessages)).toBe(1);

  await page.reload();
  await waitForCachedWorkspace(page);

  await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');
  await expect(page.getByTestId('message-scroller')).toContainText('Newest message from fixture');
  await expect(
    page.getByRole('button', { name: /Pinned message 1 of 2.*Fixture message 79/ }),
  ).toBeVisible();
  expect((await fixtureStats(page))?.getPinnedMessages).toBe(0);
});

test('repairs cached private-chat history behind the dialog head after reconnect', async ({
  page,
}) => {
  await page.goto(CACHE_PATH);
  await releaseConnectionAndWaitUntilReady(page);
  const scroller = page.getByTestId('message-scroller');
  await expect(scroller).toContainText('Newest message from fixture');
  await expect.poll(() => fixtureStats(page).then((stats) => stats?.getPinnedMessages)).toBe(1);

  // Recreate the tvbug's persisted state: Telegram's current dialog points to
  // an outgoing message absent from the cached conversation history.
  await page.evaluate(async (scenario) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`televecha-e2e-${scenario}`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('messages', 'readwrite');
        transaction.objectStore('messages').delete(['u:101', 79]);
        transaction.objectStore('messages').delete(['u:101', 80]);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, CACHE_SCENARIO);

  await page.reload();
  await waitForCachedWorkspace(page);
  await expect(scroller.locator('article.message').last()).toHaveAttribute('data-message-id', '78');
  await expect(chatButton(page, /Alice Fixture/)).toContainText('Newest message from fixture');
  const retained = scroller.locator('article[data-message-id="78"]');
  await retained.evaluate((element) => {
    element.dataset.beforeRepair = 'preserved';
  });

  await releaseConnectionAndWaitUntilReady(page);
  await expect(scroller).toContainText('Newest message from fixture');
  await expect(scroller.locator('article[data-message-id="79"]')).toHaveCount(1);
  await expect(scroller.locator('article[data-message-id="80"]')).toHaveCount(1);
  await expect(retained).toHaveAttribute('data-before-repair', 'preserved');
  expect((await fixtureStats(page))?.getHistory).toBe(1);
});

test('restores an assigned chat background from cache before Telegram reconnects', async ({
  page,
}) => {
  await page.goto(CACHE_PATH);
  await releaseConnectionAndWaitUntilReady(page);
  await expectAssignedChatBackground(page);
  await expect.poll(() => fixtureStats(page).then((stats) => stats?.getChatAppearance)).toBe(1);
  await expect.poll(() => fixtureStats(page).then((stats) => stats?.downloadWallpaper)).toBe(1);

  await page.reload();
  await waitForCachedWorkspace(page);

  await expectAssignedChatBackground(page);
  expect((await fixtureStats(page))?.getChatAppearance).toBe(0);
  expect((await fixtureStats(page))?.downloadWallpaper).toBe(0);
});

test('loads the assigned chat background after reconnecting without cached appearance', async ({
  page,
}) => {
  await page.goto(CACHE_PATH);
  await releaseConnectionAndWaitUntilReady(page);
  await expectAssignedChatBackground(page);
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('televecha-e2e-held-connect+multiple-pins');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('meta', 'readwrite');
    transaction.objectStore('meta').delete('resource-metadata:chat-appearance:u:101');
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload();
  await waitForCachedWorkspace(page);
  await expect(page.locator('.message-scroll-shell')).not.toHaveAttribute(
    'data-chat-wallpaper',
    'telegram',
  );
  await releaseConnectionAndWaitUntilReady(page);
  await expectAssignedChatBackground(page);
});

test('restores a selected Telegram background from cache before Telegram reconnects', async ({
  page,
}) => {
  const scenario = 'held-connect';
  await page.goto(`/?scenario=${scenario}`);
  await releaseConnectionAndWaitUntilReady(page, scenario);
  await page.getByRole('button', { name: 'Open settings' }).click();
  const telegramBackground = page.getByRole('button', {
    name: 'Telegram background fixture-lagoon',
  });
  await expect(telegramBackground).toBeVisible();
  await telegramBackground.click();
  await expect(page.locator('html')).toHaveAttribute('data-wallpaper', 'telegram');
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--wallpaper-asset').trim(),
      ),
    )
    .toMatch(/^url\("blob:/u);

  await page.reload();
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const snapshot = window.__televechaRuntimes?.get(key)?.engine.snapshot();
        return snapshot?.dialogs.length && !snapshot.online && snapshot.phase === 'connecting';
      }, `fixture:${scenario}`),
    )
    .toBe(true);

  await expect(page.locator('html')).toHaveAttribute('data-wallpaper', 'telegram');
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--wallpaper-asset').trim(),
      ),
    )
    .toMatch(/^url\("blob:/u);
  expect((await fixtureStats(page))?.downloadWallpaper).toBe(0);
});

test('restores shared-media counts from cache before Telegram reconnects', async ({ page }) => {
  await page.goto(CACHE_PATH);
  await releaseConnectionAndWaitUntilReady(page);
  const photos = page.locator('aside.details-pane').getByRole('button', { name: 'Photos 128' });
  await expect(photos).toBeVisible();
  await expect
    .poll(() => fixtureStats(page).then((stats) => stats?.getSharedMediaCounts ?? 0))
    .toBeGreaterThan(0);

  await page.reload();
  await waitForCachedWorkspace(page);

  await expect(photos).toBeVisible();
  expect((await fixtureStats(page))?.getSharedMediaCounts).toBe(0);
});

test('restores group members from cache before Telegram reconnects', async ({ page }) => {
  const scenario = 'held-connect';
  await page.goto(`/?scenario=${scenario}&chat=g%3A303`);
  await releaseConnectionAndWaitUntilReady(page, scenario);
  const members = page.locator('.group-members');
  await expect(members).toContainText('Fixture Author');
  await expect(members).toContainText('Another Member');

  await page.reload();
  await waitForCachedWorkspace(page, scenario);

  await expect(members).toContainText('Fixture Author');
  await expect(members).toContainText('Another Member');
});

test('restores bot commands from cache before Telegram reconnects', async ({ page }) => {
  const scenario = 'held-connect';
  await page.goto(`/?scenario=${scenario}&chat=g%3A303`);
  await releaseConnectionAndWaitUntilReady(page, scenario);
  await expect.poll(() => fixtureStats(page).then((stats) => stats?.getBotCommands)).toBe(1);
  const commands = page.getByRole('button', { name: 'Commands' });
  await expect(commands).toBeVisible();

  await page.reload();
  await waitForCachedWorkspace(page, scenario);

  await expect(commands).toBeVisible();
  await commands.click();
  await expect(
    page.getByRole('menuitem', { name: /\/help.*Show available commands/ }),
  ).toBeVisible();
  expect((await fixtureStats(page))?.getBotCommands).toBe(0);
});

test('restores sticker indexes from cache before Telegram reconnects', async ({ page }) => {
  const scenario = 'held-connect';
  await page.goto(`/?scenario=${scenario}&chat=u%3A101`);
  await releaseConnectionAndWaitUntilReady(page, scenario);
  await page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' }).click();
  let picker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
  await picker.getByRole('button', { name: 'Stickers' }).click();
  await expect(picker.getByRole('button', { name: 'Fixture Animals' })).toBeVisible();
  await expect.poll(() => fixtureStats(page).then((stats) => stats?.getStickerPacks)).toBe(1);
  await page.keyboard.press('Escape');

  await page.reload();
  await waitForCachedWorkspace(page, scenario);
  await page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' }).click();
  picker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
  await picker.getByRole('button', { name: 'Stickers' }).click();

  await expect(picker.getByRole('button', { name: 'Fixture Animals' })).toBeVisible();
  expect((await fixtureStats(page))?.getStickerPacks).toBe(0);
});

test('reuses cached GIF search results before Telegram reconnects', async ({ page }) => {
  const scenario = 'held-connect';
  await page.goto(`/?scenario=${scenario}&chat=u%3A101`);
  await releaseConnectionAndWaitUntilReady(page, scenario);
  await page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' }).click();
  let picker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
  await picker.getByRole('button', { name: 'GIFs' }).click();
  await picker.getByPlaceholder('Search gifs').fill('cat');
  await expect(picker.getByRole('button', { name: 'Send GIF cat result' })).toBeVisible();
  await expect.poll(() => fixtureStats(page).then((stats) => stats?.searchGifs)).toBe(1);
  await page.keyboard.press('Escape');

  await page.reload();
  await waitForCachedWorkspace(page, scenario);
  await page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' }).click();
  picker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
  await picker.getByRole('button', { name: 'GIFs' }).click();
  await picker.getByPlaceholder('Search gifs').fill('cat');

  await expect(picker.getByRole('button', { name: 'Send GIF cat result' })).toBeVisible();
  expect((await fixtureStats(page))?.searchGifs).toBe(0);
});

test('restores the Telegram wallpaper catalog from cache before reconnecting', async ({ page }) => {
  const scenario = 'held-connect';
  await page.goto(`/?scenario=${scenario}`);
  await releaseConnectionAndWaitUntilReady(page, scenario);
  await page.getByRole('button', { name: 'Open settings' }).click();
  const wallpaper = page.getByRole('button', { name: 'Telegram background fixture-lagoon' });
  await expect(wallpaper).toBeVisible();
  await expect.poll(() => fixtureStats(page).then((stats) => stats?.getWallpapers)).toBe(1);
  await page.getByRole('button', { name: 'Close settings' }).click();

  await page.reload();
  await waitForCachedWorkspace(page, scenario);
  await page.getByRole('button', { name: 'Open settings' }).click();

  await expect(wallpaper).toBeVisible();
  expect((await fixtureStats(page))?.getWallpapers).toBe(0);
});

test('restores reply context with a text draft after reload', async ({ page }) => {
  const scenario = 'held-connect';
  await page.goto(`/?scenario=${scenario}&chat=u%3A101`);
  await releaseConnectionAndWaitUntilReady(page, scenario);
  const message = page.locator('article[data-message-id="79"]');
  await message.hover();
  await message.getByRole('button', { name: 'Reply to message 79' }).click();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Persistent reply draft');
  await expect(page.getByTestId('composer-reply')).toContainText('Fixture message 79');
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.__televechaRuntimes?.get(key)?.engine.snapshot().drafts['u:101'],
        `fixture:${scenario}`,
      ),
    )
    .toBe('Persistent reply draft');

  await page.reload();
  await waitForCachedWorkspace(page, scenario);

  await expect(composer).toHaveValue('Persistent reply draft');
  await expect(page.getByTestId('composer-reply')).toContainText('Fixture message 79');
});

test('restores draft formatting after reload', async ({ page }) => {
  const scenario = 'held-connect';
  await page.goto(`/?scenario=${scenario}&chat=u%3A101`);
  await releaseConnectionAndWaitUntilReady(page, scenario);
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Persistent bold draft');
  await composer.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(0, 10);
  });
  await composer.dispatchEvent('contextmenu', { clientX: 420, clientY: 520 });
  await page
    .getByRole('menu', { name: 'Message formatting' })
    .getByRole('menuitem', { name: 'Bold' })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.__televechaRuntimes?.get(key)?.engine.snapshot().drafts['u:101'],
        `fixture:${scenario}`,
      ),
    )
    .toBe('Persistent bold draft');
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          window.__televechaRuntimes?.get(key)?.engine.snapshot().draftDetails['u:101']?.formats,
        `fixture:${scenario}`,
      ),
    )
    .toEqual([{ offset: 0, length: 10, kind: 'bold' }]);

  await page.reload();
  await waitForCachedWorkspace(page, scenario);
  await expect(composer).toHaveValue('Persistent bold draft');
  await expect
    .poll(() => fixtureStats(page).then((stats) => stats?.connect ?? 0))
    .toBeGreaterThanOrEqual(1);
  await page.evaluate(() => window.__televechaFixture?.releaseConnect());
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.__televechaRuntimes?.get(key)?.engine.snapshot().online,
        `fixture:${scenario}`,
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.locator('article.message').last().locator('.bold')).toHaveText('Persistent');
});

test('reuses cached message-search results before Telegram reconnects', async ({ page }) => {
  const scenario = 'held-connect';
  await page.goto(`/?scenario=${scenario}&chat=u%3A101`);
  await releaseConnectionAndWaitUntilReady(page, scenario);
  await page.getByRole('button', { name: 'Search messages' }).click();
  let search = page.getByRole('dialog', { name: 'Message search' });
  let query = search.getByRole('textbox', { name: 'Message search query' });
  await query.fill('Fixture message 79');
  await query.press('Enter');
  const resultName = /Alice Fixture.*Fixture message 79/;
  await expect(search.getByRole('button', { name: resultName })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.reload();
  await waitForCachedWorkspace(page, scenario);
  await page.getByRole('button', { name: 'Search messages' }).click();
  search = page.getByRole('dialog', { name: 'Message search' });
  query = search.getByRole('textbox', { name: 'Message search query' });
  await query.fill('Fixture message 79');
  await query.press('Enter');

  await expect(search.getByRole('button', { name: resultName })).toBeVisible();
  expect((await fixtureStats(page))?.searchMessages).toBe(0);
});

test('reuses cached peer-search results before Telegram reconnects', async ({ page }) => {
  const scenario = 'held-connect';
  await page.goto(`/?scenario=${scenario}`);
  await releaseConnectionAndWaitUntilReady(page, scenario);
  let search = page.getByRole('textbox', { name: 'Search chats' });
  await search.fill('helper');
  const bot = page.getByRole('button', { name: /Fixture Helper Bot/ });
  await expect(bot).toBeVisible();
  await expect.poll(() => fixtureStats(page).then((stats) => stats?.searchPeers)).toBe(1);

  await page.reload();
  await waitForCachedWorkspace(page, scenario);
  search = page.getByRole('textbox', { name: 'Search chats' });
  await search.fill('helper');

  await expect(bot).toBeVisible();
  expect((await fixtureStats(page))?.searchPeers).toBe(0);
});

test('reuses cached shared-media pages before Telegram reconnects', async ({ page }) => {
  const scenario = 'held-connect';
  await page.goto(`/?scenario=${scenario}&chat=u%3A101`);
  await releaseConnectionAndWaitUntilReady(page, scenario);
  await page
    .locator('aside.details-pane')
    .getByRole('button', { name: /Photos.*128/ })
    .click();
  let shared = page.getByRole('dialog', { name: 'Shared photos' });
  await expect(shared.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  await shared.getByRole('button', { name: 'Close shared photos' }).click();

  await page.reload();
  await waitForCachedWorkspace(page, scenario);
  await page
    .locator('aside.details-pane')
    .getByRole('button', { name: /Photos/ })
    .click();
  shared = page.getByRole('dialog', { name: 'Shared photos' });

  await expect(shared.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  expect((await fixtureStats(page))?.getSharedMedia).toBe(0);
});

test('keeps cached conversation metadata visible throughout reconnect synchronization', async ({
  page,
}) => {
  await page.goto(CACHE_PATH);
  await releaseConnectionAndWaitUntilReady(page);
  await page.evaluate(() => {
    window.__televechaFixture?.emit({
      type: 'presence-changed',
      peerId: 'u:101',
      presence: 'offline',
      lastSeenAt: Math.floor(Date.now() / 1000) - 60,
    });
  });
  const headerStatus = page.getByTestId('conversation-header').getByRole('status');
  await expect(headerStatus).toContainText('last seen today at');
  const expectedStatus = (await headerStatus.textContent()) ?? '';
  await expect(
    page.getByRole('button', { name: /Pinned message 1 of 2.*Fixture message 79/ }),
  ).toBeVisible();
  await expect(
    page.locator('aside.details-pane').getByRole('button', { name: 'Photos 128' }),
  ).toBeVisible();

  await page.evaluate(async (key) => {
    const runtime = window.__televechaRuntimes?.get(key);
    if (!runtime) throw new Error('Fixture runtime is unavailable');
    const target = window as typeof window & {
      __cacheRestorationSamples?: Array<{
        loading: boolean;
        messages: number;
        pinned: number;
        sharedMedia: boolean;
      }>;
      __cacheRestorationStatuses?: string[];
      __cacheRestorationCountTexts?: string[];
      __cacheRestorationCountNode?: Element;
    };
    target.__cacheRestorationSamples = [];
    target.__cacheRestorationStatuses = [];
    target.__cacheRestorationCountTexts = [];
    const status = document.querySelector('[data-testid="conversation-header"] [role="status"]');
    const photosRow = [...document.querySelectorAll('aside.details-pane .detail-row')].find(
      (row) => row.querySelector('span')?.textContent === 'Photos',
    );
    const count = photosRow?.querySelector('b');
    if (!status || !count) throw new Error('Conversation metadata is unavailable');
    target.__cacheRestorationStatuses.push(status.textContent ?? '');
    target.__cacheRestorationCountTexts.push(count.textContent ?? '');
    target.__cacheRestorationCountNode = count;
    new MutationObserver(() => {
      target.__cacheRestorationStatuses?.push(status.textContent ?? '');
    }).observe(status, { childList: true, characterData: true, subtree: true });
    new MutationObserver(() => {
      target.__cacheRestorationCountTexts?.push(count.textContent ?? '');
    }).observe(count, { childList: true, characterData: true, subtree: true });
    const unsubscribe = await runtime.runEffect(
      runtime.engine.subscribe((snapshot) => {
        if (snapshot.activePeerId !== 'u:101') return;
        target.__cacheRestorationSamples?.push({
          loading: snapshot.loadingMessages,
          messages: snapshot.messages.length,
          pinned: snapshot.pinnedMessages.length,
          sharedMedia: snapshot.sharedMediaCounts !== undefined,
        });
      }),
    );
    // The app scope owns this observer until the test page closes.
    Object.assign(target, { __cacheRestorationUnsubscribe: unsubscribe });
  }, `fixture:${CACHE_SCENARIO}`);

  await page.evaluate(() =>
    window.__televechaFixture?.emit({ type: 'connection-state', connected: false }),
  );
  await expect(
    page.getByRole('button', { name: /Offline.*Retry Telegram connection/i }),
  ).toBeVisible();
  await expect(headerStatus).toHaveText(expectedStatus);
  await expect
    .poll(() => fixtureStats(page).then((stats) => stats?.connect ?? 0))
    .toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    window.__televechaFixture?.releaseConnect();
  });

  await expect
    .poll(() =>
      page.evaluate((key) => {
        const snapshot = window.__televechaRuntimes?.get(key)?.engine.snapshot();
        return snapshot?.phase === 'ready' && snapshot.online && snapshot.sync === 'current';
      }, `fixture:${CACHE_SCENARIO}`),
    )
    .toBe(true);
  await expect(
    page.getByRole('button', { name: /Pinned message 1 of 2.*Fixture message 79/ }),
  ).toBeVisible();
  await expect(
    page.locator('aside.details-pane').getByRole('button', { name: 'Photos 128' }),
  ).toBeVisible();
  await expect(headerStatus).toHaveText(expectedStatus);

  const observations = await page.evaluate(() => {
    const target = window as typeof window & {
      __cacheRestorationSamples?: Array<{
        loading: boolean;
        messages: number;
        pinned: number;
        sharedMedia: boolean;
      }>;
      __cacheRestorationStatuses?: string[];
      __cacheRestorationCountTexts?: string[];
      __cacheRestorationCountNode?: Element;
    };
    const photosRow = [...document.querySelectorAll('aside.details-pane .detail-row')].find(
      (row) => row.querySelector('span')?.textContent === 'Photos',
    );
    return {
      samples: target.__cacheRestorationSamples ?? [],
      statuses: target.__cacheRestorationStatuses ?? [],
      countTexts: target.__cacheRestorationCountTexts ?? [],
      countNodeStable: target.__cacheRestorationCountNode === photosRow?.querySelector('b'),
    };
  });
  const { samples, statuses, countTexts, countNodeStable } = observations;
  expect(samples.length).toBeGreaterThan(0);
  expect(samples).toEqual(
    samples.map(() => ({ loading: false, messages: 50, pinned: 2, sharedMedia: true })),
  );
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses).toEqual(statuses.map(() => expectedStatus));
  expect(countTexts.length).toBeGreaterThan(0);
  expect(countTexts).toEqual(countTexts.map(() => '128'));
  expect(countNodeStable).toBe(true);
});

test('keeps the pin bar mounted and the wallpaper anchored while pins revalidate', async ({
  page,
}) => {
  await page.goto(CACHE_PATH);
  await releaseConnectionAndWaitUntilReady(page);
  const pin = page.locator('.pinned-message-bar');
  await expect(pin).toBeVisible();
  const requestsBefore = (await fixtureStats(page))?.getPinnedMessages ?? 0;

  await page.evaluate(async (key) => {
    const runtime = window.__televechaRuntimes?.get(key);
    const pin = document.querySelector('.pinned-message-bar');
    const wallpaper = document.querySelector('.chat-wallpaper');
    if (!runtime || !pin || !wallpaper) throw new Error('Pinned conversation is unavailable');
    const target = window as typeof window & {
      __pinRevalidation?: {
        pin: Element;
        wallpaper: Element;
        pinnedCounts: number[];
        wallpaperTop: number;
      };
    };
    target.__pinRevalidation = {
      pin,
      wallpaper,
      pinnedCounts: [],
      wallpaperTop: wallpaper.getBoundingClientRect().top,
    };
    const unsubscribe = await runtime.runEffect(
      runtime.engine.subscribe((snapshot) => {
        if (snapshot.activePeerId === 'u:101') {
          target.__pinRevalidation?.pinnedCounts.push(snapshot.pinnedMessages.length);
        }
      }),
    );
    // The app scope owns this observer until the test page closes.
    Object.assign(target, { __cacheRestorationUnsubscribe: unsubscribe });
  }, `fixture:${CACHE_SCENARIO}`);

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'pinned-messages',
      pts: 11,
      ptsCount: 1,
      peerId: 'u:101',
      messageIds: [79, 5],
      pinned: true,
    }),
  );
  await expect
    .poll(() => fixtureStats(page).then((stats) => stats?.getPinnedMessages ?? 0))
    .toBeGreaterThan(requestsBefore);
  await expect(pin).toBeVisible();

  const result = await page.evaluate(() => {
    const target = window as typeof window & {
      __pinRevalidation?: {
        pin: Element;
        wallpaper: Element;
        pinnedCounts: number[];
        wallpaperTop: number;
      };
    };
    const recorded = target.__pinRevalidation;
    if (!recorded) throw new Error('Pin revalidation was not observed');
    return {
      pinnedCounts: recorded.pinnedCounts,
      samePin: recorded.pin === document.querySelector('.pinned-message-bar'),
      sameWallpaper: recorded.wallpaper === document.querySelector('.chat-wallpaper'),
      wallpaperTop: document.querySelector('.chat-wallpaper')?.getBoundingClientRect().top,
      initialWallpaperTop: recorded.wallpaperTop,
    };
  });
  expect(result.pinnedCounts.length).toBeGreaterThan(0);
  expect(result.pinnedCounts).toEqual(result.pinnedCounts.map(() => 2));
  expect(result.samePin).toBe(true);
  expect(result.sameWallpaper).toBe(true);
  expect(result.wallpaperTop).toBe(result.initialWallpaperTop);
});
