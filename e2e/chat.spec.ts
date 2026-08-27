import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const alice = page.locator('[data-testid="chat-list"]').getByRole('button', {
    name: /Alice Fixture/,
  });
  await expect(alice).toBeVisible();
  await alice.click();
  await expect(
    page.getByTestId('message-scroller').getByText('Newest message from fixture'),
  ).toBeVisible();
});

test('renders real previews, avatars, a contained layout, and a visible composer', async ({
  page,
}) => {
  const alice = page.locator('[data-testid="chat-list"]').getByRole('button', {
    name: /Alice Fixture/,
  });
  await expect(alice).toContainText('Newest message from fixture');
  await expect(alice).not.toContainText('No messages yet');
  await expect(alice.locator('img')).toBeVisible();

  const layout = await page.evaluate(() => {
    const chatList = document.querySelector<HTMLElement>('[data-testid="chat-list"]')!;
    const messages = document.querySelector<HTMLElement>('[data-testid="message-scroller"]')!;
    const composer = document.querySelector<HTMLElement>('textarea[aria-label="Message"]')!;
    return {
      documentFits: document.documentElement.scrollHeight === document.documentElement.clientHeight,
      bodyFits: document.body.scrollHeight === document.body.clientHeight,
      chatListOverflow: getComputedStyle(chatList).overflowY,
      messageOverflow: getComputedStyle(messages).overflowY,
      composerBottom: composer.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
    };
  });

  expect(layout.documentFits).toBe(true);
  expect(layout.bodyFits).toBe(true);
  expect(layout.chatListOverflow).toBe('auto');
  expect(layout.messageOverflow).toBe('auto');
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewportHeight);
  await expect
    .poll(() =>
      page
        .getByTestId('message-scroller')
        .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    )
    .toBeLessThan(3);
});

test('shows top-message delivery state and labels media dialogs as non-empty', async ({ page }) => {
  const alice = page.getByTestId('chat-list').getByRole('button', { name: /Alice Fixture/ });
  await expect(alice.locator('.chat-delivery-status')).toHaveAttribute(
    'aria-label',
    'Last message sent',
  );

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'read-history',
      pts: 11,
      ptsCount: 1,
      peerId: 'u:101',
      maxMessageId: 80,
      direction: 'outbox',
    }),
  );
  await expect(alice.locator('.chat-delivery-status')).toHaveAttribute(
    'aria-label',
    'Last message read',
  );

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 12,
      ptsCount: 1,
      message: {
        id: 181,
        peerId: 'u:101',
        senderId: 'self',
        text: '',
        date: 1_700_003_181,
        outgoing: true,
        media: { kind: 'photo', name: 'new-photo.jpg', mimeType: 'image/jpeg' },
      },
    }),
  );
  await expect(alice).toContainText('Photo');
  await expect(alice).not.toContainText('No messages yet');
  await expect(alice.locator('.chat-delivery-status')).toHaveAttribute(
    'aria-label',
    'Last message sent',
  );
});

test('fills a one-message first page automatically and keeps the newest message at the bottom', async ({
  page,
}) => {
  await page.goto('/?scenario=single-message-first-page');
  const alice = page.locator('[data-testid="chat-list"]').getByRole('button', {
    name: /Alice Fixture/,
  });
  await expect(alice).toBeVisible();
  await alice.click();

  const scroller = page.getByTestId('message-scroller');
  await expect(scroller.getByText('Newest message from fixture')).toBeVisible();
  await expect.poll(() => page.locator('article.message').count()).toBeGreaterThan(1);
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(3);
});

test('bottom-aligns a conversation that is shorter than the viewport', async ({ page }) => {
  await page
    .locator('[data-testid="chat-list"]')
    .getByRole('button', { name: /Release Channel/ })
    .click();
  const scroller = page.getByTestId('message-scroller');
  await expect(scroller.getByText('Release notes are ready')).toBeVisible();
  await expect
    .poll(() =>
      scroller.evaluate((element) => {
        const lastMessage = element.querySelector<HTMLElement>('article.message:last-of-type');
        if (!lastMessage) return Number.POSITIVE_INFINITY;
        return element.getBoundingClientRect().bottom - lastMessage.getBoundingClientRect().bottom;
      }),
    )
    .toBeLessThan(40);
});

test('keeps the last bubble above the composer when the composer grows', async ({ page }) => {
  await page.getByRole('button', { name: 'Reply to message 79' }).click();
  await expect(page.getByTestId('composer-reply')).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('[data-testid="message-scroller"]');
        const composer = document.querySelector<HTMLElement>('.chat-composer');
        const last = scroller?.querySelector<HTMLElement>('article.message:last-of-type');
        if (!scroller || !composer || !last) return Number.POSITIVE_INFINITY;
        return last.getBoundingClientRect().bottom - composer.getBoundingClientRect().top;
      }),
    )
    .toBeLessThanOrEqual(-8);
});

test('keeps outgoing message bubbles dark and distinct from incoming messages', async ({
  page,
}) => {
  const colors = await page.evaluate(() => {
    const readRgb = (selector: string, property: 'backgroundColor' | 'color') => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const value = getComputedStyle(element)[property];
      return (value.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number);
    };
    return {
      incoming: readRgb('.message.incoming', 'backgroundColor'),
      outgoing: readRgb('.message.outgoing', 'backgroundColor'),
      outgoingText: readRgb('.message.outgoing', 'color'),
    };
  });
  const average = (rgb: number[]) => rgb.reduce((sum, channel) => sum + channel, 0) / rgb.length;

  expect(average(colors.outgoing)).toBeLessThan(55);
  expect(average(colors.outgoing)).toBeGreaterThan(average(colors.incoming));
  expect(average(colors.outgoingText)).toBeLessThan(235);
});

test('uses global media totals and only renders working details controls', async ({ page }) => {
  const details = page.locator('aside.details-pane');
  await expect(details).toContainText('Photos');
  await expect(details).toContainText('128');
  await expect(details).toContainText('16');
  await expect(details).toContainText('44');
  await expect(page.getByRole('button', { name: 'Sound' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Search messages' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close details' })).toHaveCount(1);

  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(page.getByRole('button', { name: 'Open details' })).toBeVisible();
});

test('updates shared-media totals in the mounted details pane', async ({ page }) => {
  await page.goto('/?scenario=held-shared-media-counts');
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Alice Fixture/ })
    .click();
  const details = page.locator('aside.details-pane');
  await expect
    .poll(() => page.evaluate(() => window.__televechaFixture?.stats.getSharedMediaCounts))
    .toBeGreaterThanOrEqual(1);

  await page.evaluate(() => window.__televechaFixture?.releaseSharedMediaCounts());

  await expect(details.getByRole('button', { name: 'Photos 128' })).toBeVisible();
});

test('loads shared-media totals for the restored dialog without switching dialogs', async ({
  page,
}) => {
  await page.reload();

  await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');
  await expect(
    page.locator('aside.details-pane').getByRole('button', { name: 'Photos 128' }),
  ).toBeVisible();
});

test('updates reused header and details avatars when switching chats', async ({ page }) => {
  const headerAvatar = page.getByTestId('conversation-header').locator('img');
  const detailsAvatar = page.getByTestId('details-avatar').locator('img');
  await expect(headerAvatar).toBeVisible();
  await expect(detailsAvatar).toBeVisible();
  const aliceHeaderSource = await headerAvatar.getAttribute('src');
  const aliceDetailsSource = await detailsAvatar.getAttribute('src');

  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Release Channel/ })
    .click();

  await expect(headerAvatar).not.toHaveAttribute('src', aliceHeaderSource ?? '');
  await expect(detailsAvatar).not.toHaveAttribute('src', aliceDetailsSource ?? '');
  await expect(page.getByTestId('conversation-header')).toContainText('Release Channel');
});

test('loads older messages automatically at the top and preserves the scroll anchor', async ({
  page,
}) => {
  await expect(page.locator('article.message')).toHaveCount(50);
  await expect(page.getByRole('button', { name: 'Load older messages' })).toHaveCount(0);

  const scroller = page.getByTestId('message-scroller');
  const anchor = page.getByText('Fixture message 31', { exact: true });
  const anchorOffsetBefore = await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    element.scrollTop = 0;
    const anchorElement = [...element.querySelectorAll('p')].find(
      (candidate) => candidate.textContent === 'Fixture message 31',
    );
    if (!anchorElement) throw new Error('Could not find the current oldest message');
    return anchorElement.getBoundingClientRect().top - element.getBoundingClientRect().top;
  });
  await expect(page.locator('article.message')).toHaveCount(80);
  await expect(page.getByText('Fixture message 1', { exact: true })).toBeAttached();
  await expect(
    page.getByTestId('message-scroller').getByText('Newest message from fixture'),
  ).toBeAttached();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const anchorOffsetAfter = await anchor.evaluate(
        (element, scrollElement) =>
          element.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top,
        await scroller.elementHandle(),
      );
      return Math.abs(anchorOffsetAfter - anchorOffsetBefore);
    })
    .toBeLessThan(3);
});

test('shows a chat scrollbar and jumps back to the present', async ({ page }) => {
  const scroller = page.getByTestId('message-scroller');
  await expect(page.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);
  expect(
    await scroller.evaluate((element) =>
      getComputedStyle(element, '::-webkit-scrollbar').getPropertyValue('display'),
    ),
  ).not.toBe('none');

  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 600);
  });
  const jump = page.getByRole('button', { name: 'Jump to present' });
  await expect(jump).toBeVisible();
  await jump.click();

  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(3);
  await expect(jump).toHaveCount(0);
});

test('restores the last opened chat after reload', async ({ page }) => {
  await page
    .locator('[data-testid="chat-list"]')
    .getByRole('button', { name: /Release Channel/ })
    .click();
  await expect(page.getByText('Release notes are ready', { exact: false }).last()).toBeVisible();
  await page.reload();
  await expect(page.getByText('Release Channel').last()).toBeVisible();
  await expect(page.getByText('Release notes are ready', { exact: false }).last()).toBeVisible();
});

test('does not flicker back to an empty conversation', async ({ page }) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    expect(await page.locator('article.message').count()).toBeGreaterThan(0);
    await page.waitForTimeout(25);
  }
  await expect(page.getByText('Start the conversation')).toHaveCount(0);
});
