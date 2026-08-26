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
  await expect(details).toContainText('Media');
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

test('updates reused header and details avatars when switching chats', async ({ page }) => {
  const headerAvatar = page.locator('section > header img');
  const detailsAvatar = page.locator('aside.details-pane img');
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
  await expect(page.locator('section > header')).toContainText('Release Channel');
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
