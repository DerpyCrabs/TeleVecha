import { expect, test } from '@playwright/test';

import { chatButton, fixtureStats, openReady, selectAlice } from './helpers';

test('shares the active-tab lease between app instances in the same document', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-list')).toBeVisible();

  const acquired = await page.evaluate(async () => {
    const { acquireSingleTabLease } = await import('../src/telegram/session/tabLock');
    const first = await acquireSingleTabLease();
    const second = await acquireSingleTabLease();
    first?.release();
    second?.release();
    return Boolean(first && second);
  });

  expect(acquired).toBe(true);
  await expect(page.getByTestId('chat-list')).toBeVisible();
});

test('keeps two tabs interactive with independent conversations', async ({ context, page }) => {
  await openReady(page);
  await selectAlice(page);

  const second = await context.newPage();
  await openReady(second, '/?chat=c%3A202');
  await expect(second.getByTestId('conversation-header')).toContainText('Release Channel');
  await expect(second.locator('textarea[aria-label="Message"]')).toHaveCount(1);
  await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');

  await second.locator('textarea[aria-label="Message"]').fill('Sent from the follower tab');
  await second.getByRole('button', { name: 'Send message' }).click();
  await expect(
    second.locator('article.message', { hasText: 'Sent from the follower tab' }),
  ).toBeVisible();
  await expect(chatButton(page, /Release Channel/)).toContainText('Sent from the follower tab');
  await expect.poll(() => page.evaluate(() => window.__televechaFixture?.stats.sendText)).toBe(1);
});

test('gives chat links independent-tab URLs without moving the current tab', async ({
  context,
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  const release = chatButton(page, /Release Channel/);
  await expect(release).toHaveAttribute('href', /[?&]chat=c%3A202/u);
  const href = await release.getAttribute('href');
  if (!href) throw new Error('Release Channel has no link target.');

  await release.dispatchEvent('auxclick', { button: 1 });
  await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');

  const second = await context.newPage();
  await openReady(second, href);
  await expect(second.getByTestId('conversation-header')).toContainText('Release Channel');
});

test('marks a chat read when any live tab is visible and forgets a closed follower', async ({
  context,
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  const second = await context.newPage();
  await openReady(second, '/?chat=u%3A101');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.evaluate(async () => {
    const runtime = window.__televechaRuntimes?.get('fixture:default');
    await runtime?.engine.setActiveConversationVisibility('u:101', {
      visible: false,
      atBottom: true,
    });
  });
  await second.evaluate(async () => {
    const runtime = window.__televechaRuntimes?.get('fixture:default');
    await runtime?.engine.setActiveConversationVisibility('u:101', {
      visible: true,
      atBottom: true,
    });
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
        text: 'Visible in the follower',
        date: 1_700_004_001,
        outgoing: false,
      },
    }),
  );
  await expect
    .poll(async () => (await fixtureStats(page))?.readHistory ?? 0)
    .toBeGreaterThan(readsBefore);

  await second.evaluate(async () => {
    const runtime = window.__televechaRuntimes?.get('fixture:default');
    await runtime?.engine.setActiveConversationVisibility('u:101', {
      visible: true,
      atBottom: true,
    });
  });
  await second.close();
  await page.evaluate(async () => {
    const runtime = window.__televechaRuntimes?.get('fixture:default');
    await runtime?.engine.setActiveConversationVisibility('u:101', {
      visible: false,
      atBottom: true,
    });
  });

  const readsAfterClose = (await fixtureStats(page))?.readHistory ?? 0;
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 12,
      ptsCount: 1,
      message: {
        id: 82,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'No app tab is visible',
        date: 1_700_004_002,
        outgoing: false,
      },
    }),
  );
  await page.waitForTimeout(500);
  expect((await fixtureStats(page))?.readHistory).toBe(readsAfterClose);
});

test('reuses owner-cached media in a follower without another Telegram download', async ({
  context,
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  await expect(page.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  await expect
    .poll(async () => (await fixtureStats(page))?.downloadMedia ?? 0)
    .toBeGreaterThanOrEqual(2);
  const downloads = (await fixtureStats(page))?.downloadMedia;

  const second = await context.newPage();
  await openReady(second, '/?chat=u%3A101');
  await expect(second.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  await page.waitForTimeout(250);

  expect((await fixtureStats(page))?.downloadMedia).toBe(downloads);
});

test('propagates a follower-initiated sign-out to every tab', async ({ context, page }) => {
  await openReady(page, '/?chat=u%3A101');
  const second = await context.newPage();
  await openReady(second, '/?chat=c%3A202');

  await second.getByRole('button', { name: 'Open settings' }).click();
  await second
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Sign out' })
    .click();

  await expect(second.getByRole('heading', { name: 'Your phone number' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your phone number' })).toBeVisible();
  await expect(page.getByTestId('chat-list').locator('.chat-row')).toHaveCount(0);
});

test('synchronizes canonical drafts and promotes a follower after the owner closes', async ({
  context,
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  const second = await context.newPage();
  await openReady(second, '/?chat=u%3A101');

  await page.getByRole('textbox', { name: 'Message' }).fill('Shared draft');
  await expect(second.getByRole('textbox', { name: 'Message' })).toHaveValue('Shared draft');

  await page.close();
  await expect(second.getByRole('button', { name: 'Send message' })).toBeDisabled({
    timeout: 5_000,
  });
  const send = second.getByRole('button', { name: 'Send message' });
  await expect(send).toBeEnabled({ timeout: 15_000 });
  await second.getByRole('textbox', { name: 'Message' }).fill('Sent after automatic takeover');
  await send.click();
  await expect(
    second.locator('article.message', { hasText: 'Sent after automatic takeover' }),
  ).toBeVisible({ timeout: 15_000 });
});

test('never replaces rapid local input with another tab draft snapshot', async ({
  context,
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  const second = await context.newPage();
  await openReady(second, '/?chat=u%3A101');
  const localDraft = 'fast-local-input-'.repeat(8);
  const typing = second
    .getByRole('textbox', { name: 'Message' })
    .pressSequentially(localDraft, { delay: 2 });

  await page.waitForTimeout(20);
  await page.getByRole('textbox', { name: 'Message' }).fill('older remote draft');
  await typing;

  await expect(second.getByRole('textbox', { name: 'Message' })).toHaveValue(localDraft);
  await page.getByRole('textbox', { name: 'Message' }).fill('newer remote draft');
  await page.waitForTimeout(100);
  await expect(second.getByRole('textbox', { name: 'Message' })).toHaveValue(localDraft);
});

test('preserves a follower conversation when it takes ownership', async ({ context, page }) => {
  await openReady(page, '/?chat=u%3A101');
  const second = await context.newPage();
  await openReady(second, '/?chat=c%3A202');
  await expect(second.getByTestId('conversation-header')).toContainText('Release Channel');

  await page.close();
  const send = second.getByRole('button', { name: 'Send message' });
  await expect(second.getByTestId('conversation-header')).toContainText('Release Channel');
  await expect
    .poll(() =>
      second.evaluate(
        () => window.__televechaRuntimes?.get('fixture:default')?.engine.snapshot().online,
      ),
    )
    .toBe(true);
  await second.getByRole('textbox', { name: 'Message' }).fill('Release survives takeover');
  await expect(send).toBeEnabled({ timeout: 15_000 });
  await send.click();
  await expect(
    second.locator('article.message', { hasText: 'Release survives takeover' }),
  ).toBeVisible();
});

test('elects exactly one replacement owner while two followers remain interactive', async ({
  context,
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  const second = await context.newPage();
  const third = await context.newPage();
  await openReady(second, '/?chat=c%3A202');
  await openReady(third, '/?chat=u%3A101');

  await page.close();
  await expect
    .poll(async () => {
      const states = await Promise.all(
        [second, third].map((tab) =>
          tab.evaluate(
            () => window.__televechaRuntimes?.get('fixture:default')?.engine.snapshot().online,
          ),
        ),
      );
      return states.every(Boolean);
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const owners = await Promise.all(
        [second, third].map((tab) => tab.evaluate(() => Boolean(window.__televechaFixture))),
      );
      return owners.filter(Boolean).length;
    })
    .toBe(1);

  await second.getByRole('textbox', { name: 'Message' }).fill('Release from two followers');
  await third.getByRole('textbox', { name: 'Message' }).fill('Alice from two followers');
  await Promise.all([
    second.getByRole('button', { name: 'Send message' }).click(),
    third.getByRole('button', { name: 'Send message' }).click(),
  ]);

  await expect(
    second.locator('article.message', { hasText: 'Release from two followers' }),
  ).toBeVisible();
  await expect(
    third.locator('article.message', { hasText: 'Alice from two followers' }),
  ).toBeVisible();
  await expect(chatButton(second, /Alice Fixture/)).toContainText('Alice from two followers');
  await expect(chatButton(third, /Release Channel/)).toContainText('Release from two followers');
  await expect
    .poll(async () => {
      const sends = await Promise.all(
        [second, third].map((tab) =>
          tab.evaluate(() => window.__televechaFixture?.stats.sendText ?? 0),
        ),
      );
      return sends.reduce((total, count) => total + count, 0);
    })
    .toBe(2);
});

test('rejoins a reloaded follower without replacing the current owner', async ({
  context,
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  const second = await context.newPage();
  await openReady(second, '/?chat=c%3A202');
  expect(await page.evaluate(() => Boolean(window.__televechaFixture))).toBe(true);
  expect(await second.evaluate(() => Boolean(window.__televechaFixture))).toBe(false);

  await openReady(second, '/?chat=c%3A202');

  await expect(second.getByTestId('conversation-header')).toContainText('Release Channel');
  expect(await page.evaluate(() => Boolean(window.__televechaFixture))).toBe(true);
  expect(await second.evaluate(() => Boolean(window.__televechaFixture))).toBe(false);
  await second.getByRole('textbox', { name: 'Message' }).fill('Sent after follower reload');
  await second.getByRole('button', { name: 'Send message' }).click();
  await expect(
    second.locator('article.message', { hasText: 'Sent after follower reload' }),
  ).toBeVisible();
  await expect(chatButton(page, /Release Channel/)).toContainText('Sent after follower reload');
  await expect.poll(() => page.evaluate(() => window.__televechaFixture?.stats.sendText)).toBe(1);
});
