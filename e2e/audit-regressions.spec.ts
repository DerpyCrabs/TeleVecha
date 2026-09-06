import { expect, test } from '@playwright/test';

import { chatButton, fixtureStats, openReady, selectAlice } from './helpers';

test('keeps an open conversation live when another tab views a different chat', async ({
  context,
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  const second = await context.newPage();
  try {
    await openReady(second, '/?chat=c%3A202');
    await page.evaluate(() =>
      window.__televechaFixture?.emit({
        type: 'new-message',
        pts: 11,
        ptsCount: 1,
        message: {
          id: 81,
          peerId: 'u:101',
          senderId: 'u:101',
          text: 'Live in every open tab',
          date: 1_700_005_001,
          outgoing: false,
        },
      }),
    );

    await expect(
      page.locator('article.message', { hasText: 'Live in every open tab' }),
    ).toBeVisible({ timeout: 1_000 });
  } finally {
    await second.close();
  }
});

test('marks a visible conversation read when another tab owns a different chat', async ({
  context,
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  const second = await context.newPage();
  try {
    await openReady(second, '/?chat=c%3A202');
    await page.evaluate(async () => {
      const runtime = window.__televechaRuntimes?.get('fixture:default');
      if (runtime)
        await runtime.runEffect(
          runtime.engine.setActiveConversationVisibility('u:101', {
            visible: true,
            atBottom: true,
          }),
        );
    });
    const readsBefore = (await fixtureStats(page))?.readHistory ?? 0;
    await page.evaluate(() =>
      window.__televechaFixture?.emit({
        type: 'new-message',
        pts: 11,
        ptsCount: 1,
        message: {
          id: 81,
          peerId: 'u:101',
          senderId: 'u:101',
          text: 'Already visible',
          date: 1_700_005_002,
          outgoing: false,
        },
      }),
    );

    await expect
      .poll(async () => (await fixtureStats(page))?.readHistory ?? 0, { timeout: 1_000 })
      .toBeGreaterThan(readsBefore);
  } finally {
    await second.close();
  }
});

test('does not restore a follower draft after a slow send is durably accepted', async ({
  context,
  page,
}) => {
  await openReady(page, '/?scenario=held-send&chat=u%3A101');
  const second = await context.newPage();
  await second.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    Object.defineProperty(window, 'setTimeout', {
      configurable: true,
      value: (handler: TimerHandler, timeout = 0, ...args: unknown[]) =>
        nativeSetTimeout(handler, timeout === 30_000 ? 75 : timeout, ...args),
    });
  });
  try {
    await openReady(second, '/?scenario=held-send&chat=u%3A101');
    const composer = second.getByRole('textbox', { name: 'Message' });
    await composer.fill('One slow send');
    await second.getByRole('button', { name: 'Send message' }).click();
    await second.waitForTimeout(125);
    await page.evaluate(() => window.__televechaFixture?.releaseSend());
    await expect(second.locator('article.message', { hasText: 'One slow send' })).toBeVisible();
    await expect(composer).toHaveValue('');
  } finally {
    await page.evaluate(() => window.__televechaFixture?.releaseSend());
    await second.close();
  }
});

test('warns that deleting a chat also removes its draft', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await page.getByRole('textbox', { name: 'Message' }).fill('Unsaved private draft');
  const alice = chatButton(page, /Alice Fixture/);
  await alice.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete chat' }).click();

  await expect(page.getByRole('dialog', { name: 'Delete chat' })).toContainText(/draft/iu);
});

test('warns that deleting a chat also cancels queued sends', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await page.getByRole('textbox', { name: 'Message' }).fill('FAIL');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByLabel('Failed message actions')).toBeVisible();
  const alice = chatButton(page, /Alice Fixture/);
  await alice.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete chat' }).click();

  await expect(page.getByRole('dialog', { name: 'Delete chat' })).toContainText(/queued|pending/iu);
});

test('shows the loading state while an uncached conversation is opening', async ({ page }) => {
  await openReady(page, '/?scenario=held-history');
  try {
    await chatButton(page, /Release Channel/).click();
    await expect(page.getByText('Loading messages…', { exact: true })).toBeAttached();
    await expect(page.getByText('Loading messages…', { exact: true })).toBeVisible({
      timeout: 500,
    });
  } finally {
    await page.evaluate(() => window.__televechaFixture?.releaseHistory());
  }
});

test('does not claim Telegram is connected while owner election is still pending', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = navigator.locks.request.bind(navigator.locks);
    Object.defineProperty(navigator.locks, 'request', {
      configurable: true,
      value: (...args: Parameters<LockManager['request']>) =>
        new Promise((resolve) => {
          window.setTimeout(() => resolve(Reflect.apply(original, navigator.locks, args)), 2_000);
        }),
    });
  });

  await page.goto('/');
  await expect(page.getByText('Telegram connected', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Starting TeleVecha' })).toBeVisible();
});

test('does not show an empty search result before the user submits the query', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await page.getByRole('button', { name: 'Search messages' }).click();
  const search = page.getByRole('dialog', { name: 'Message search' });
  await search.getByRole('textbox', { name: 'Message search query' }).fill('fixture');

  await expect(search.getByText('No messages found', { exact: true })).toHaveCount(0);
});

test('shows an actionable GIF loading error instead of an empty catalog', async ({ page }) => {
  await openReady(page, '/?scenario=gif-index-fails');
  await selectAlice(page);
  await page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' }).click();
  const picker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
  await picker.getByRole('button', { name: 'GIFs' }).click();

  await expect(picker.getByRole('button', { name: /retry/iu })).toBeVisible();
  await expect(picker.getByText('No GIFs found', { exact: true })).toHaveCount(0);
});

test('maps MTProto constructor names to actionable operation copy', async ({ page }) => {
  await openReady(page, '/?scenario=technical-mute-error');
  const alice = chatButton(page, /Alice Fixture/);
  await alice.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mute' }).click();
  const banner = page.locator('.operation-state-banner');
  await expect(banner).toBeVisible();

  await expect(banner).not.toContainText(/CHAT_ADMIN_REQUIRED|account\.updateNotifySettings/u);
});

test('retries a failed read receipt while the conversation remains visible', async ({ page }) => {
  await openReady(page, '/?scenario=read-receipt-fails');
  await selectAlice(page);

  await page.waitForTimeout(250);
  const attemptsDuringBackoff = (await fixtureStats(page))?.readHistoryPeers ?? [];
  expect(attemptsDuringBackoff.filter((peerId) => peerId === 'u:101')).toHaveLength(1);

  await expect
    .poll(
      async () =>
        (await fixtureStats(page))?.readHistoryPeers.filter((peerId) => peerId === 'u:101')
          .length ?? 0,
      { timeout: 2_000 },
    )
    .toBeGreaterThanOrEqual(2);
});

test('keeps the address bar synchronized when history points to a missing chat', async ({
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');
  await expect(page.getByTestId('message-scroller')).toContainText('Newest message from fixture');
  await expect
    .poll(() => page.evaluate(() => new URL(window.location.href).searchParams.get('chat')))
    .toBe('u:101');
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('chat', 'u:missing');
    window.history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

  await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');
  await expect
    .poll(() => page.evaluate(() => new URL(window.location.href).searchParams.get('chat')))
    .toBe('u:101');
});

test('reports a rejected clipboard write instead of silently closing the menu', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Clipboard.prototype, 'writeText', {
      configurable: true,
      value: () =>
        Promise.reject(new DOMException('Clipboard permission denied', 'NotAllowedError')),
    });
  });
  await openReady(page);
  await selectAlice(page);

  await page.locator('article[data-message-id="80"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy text' }).click();

  await expect(page.getByRole('alert').filter({ hasText: /copy|clipboard/iu })).toBeVisible({
    timeout: 1_000,
  });
});

test('offers a read-specific retry action after a read receipt failure', async ({ page }) => {
  await openReady(page, '/?scenario=read-receipt-fails');
  await selectAlice(page);
  const banner = page.locator('.operation-state-banner');
  await expect(banner).toBeVisible();

  await expect(banner.getByRole('button', { name: /retry.*read/iu })).toBeVisible();
});

test('provides a real retry action when Telegram peer search fails', async ({ page }) => {
  await openReady(page, '/?scenario=peer-search-fails');
  await page.getByRole('textbox', { name: 'Search chats' }).fill('someone remote');
  await expect(page.getByText('Telegram search is unavailable. Try again.')).toBeVisible();

  await expect(page.getByRole('button', { name: /retry/iu })).toBeVisible();
});

test('activates Reply with Enter', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  const reply = page.getByRole('button', { name: 'Reply to message 79' });
  await reply.focus();
  await reply.press('Enter');

  await expect(page.getByTestId('composer-reply')).toBeVisible();
});

test('gives chat rows link semantics instead of a button that ignores Space', async ({ page }) => {
  await openReady(page, '/?chat=u%3A101');
  await expect(page.getByTestId('message-scroller')).toContainText('Newest message from fixture');
  const release = chatButton(page, /Release Channel/);
  await release.focus();
  await release.press('Space');

  await expect(page.getByTestId('conversation-header')).toContainText('Release Channel');
});

test('moves focus into an ARIA menu when it opens', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await page.locator('article[data-message-id="79"]').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await expect(menu).toBeVisible();

  await expect(menu.getByRole('menuitem').first()).toBeFocused();
});
