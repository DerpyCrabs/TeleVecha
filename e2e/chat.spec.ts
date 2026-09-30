import { test } from '@playwright/test';
import { expect } from './expect';

import { openReady, selectAlice } from './helpers';

test('fills a one-message first page automatically and keeps the newest message at the bottom', async ({
  page,
}) => {
  await page.goto('/?scenario=single-message-first-page');
  const alice = page
    .locator('[data-testid="chat-list"]')
    .getByRole('button', { name: /Alice Fixture/ });
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

test('keeps consecutive messages from the same sender closer together', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  const emit = (id: number, pts: number, outgoing: boolean) =>
    page.evaluate(
      ({ id, pts, outgoing }) =>
        window.__televechaFixture?.emit({
          type: 'new-message',
          pts,
          ptsCount: 1,
          message: {
            id,
            peerId: 'u:101',
            senderId: outgoing ? '' : 'u:202',
            text: `Consecutive fixture ${id}`,
            date: 1_700_003_000 + id,
            outgoing,
          },
        }),
      { id, pts, outgoing },
    );
  await emit(181, 11, true);
  await expect(page.locator('article[data-message-id="181"]')).toBeAttached();
  await emit(182, 12, true);
  await expect(page.locator('article[data-message-id="182"]')).toBeAttached();
  await emit(183, 13, false);
  const first = page.locator('article[data-message-id="181"]');
  const second = page.locator('article[data-message-id="182"]');
  const differentSender = page.locator('article[data-message-id="183"]');
  const compact = page.locator('article[data-message-id="181"]').locator('..');
  const regular = page.locator('article[data-message-id="182"]').locator('..');
  await expect(compact).toBeVisible();
  await expect(regular).toBeVisible();
  await expect(compact).toHaveClass(/message-flow-row-compact/);
  await expect(regular).not.toHaveClass(/message-flow-row-compact/);
  const [compactGap, regularGap] = await Promise.all([
    compact.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)),
    regular.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)),
  ]);
  expect(compactGap).toBeLessThan(regularGap);
  const actualGaps = await Promise.all([
    first.evaluate(
      (element, next) => next.getBoundingClientRect().top - element.getBoundingClientRect().bottom,
      await second.elementHandle(),
    ),
    second.evaluate(
      (element, next) => next.getBoundingClientRect().top - element.getBoundingClientRect().bottom,
      await differentSender.elementHandle(),
    ),
  ]);
  expect(actualGaps[0]).toBeLessThan(actualGaps[1] - 2);
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

test('keeps a shared-media count failure out of the page error banner', async ({ page }) => {
  await openReady(page, '/?scenario=shared-media-counts-fail');
  await selectAlice(page);

  await expect
    .poll(() => page.evaluate(() => window.__televechaFixture?.stats.getSharedMediaCounts))
    .toBeGreaterThanOrEqual(2);
  await expect(page.locator('.operation-state-banner')).toHaveCount(0);
});

test('switches chats and restores the last opened chat', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('updates reused header and details avatars when switching chats', async () => {
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
  await test.step('bottom-aligns a conversation that is shorter than the viewport', async () => {
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
          return (
            element.getBoundingClientRect().bottom - lastMessage.getBoundingClientRect().bottom
          );
        }),
      )
      .toBeLessThan(40);
  });
  await test.step('restores the last opened chat after reload', async () => {
    await page
      .locator('[data-testid="chat-list"]')
      .getByRole('button', { name: /Release Channel/ })
      .click();
    await expect(page.getByText('Release notes are ready', { exact: false }).last()).toBeVisible();
    await page.reload();
    await expect(page.getByText('Release Channel').last()).toBeVisible();
    await expect(page.getByText('Release notes are ready', { exact: false }).last()).toBeVisible();
  });
});

test('loads older history and tracks the top message delivery state', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('loads older messages automatically at the top and preserves the scroll anchor', async () => {
    await expect.poll(() => page.locator('article.message').count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator('article.message').count()).toBeLessThanOrEqual(60);
    await expect(page.getByRole('button', { name: 'Load older messages' })).toHaveCount(0);

    const scroller = page.getByTestId('message-scroller');
    const anchor = await scroller.evaluate(
      (element) =>
        new Promise<{ id: string; offset: number }>((resolve, reject) => {
          element.addEventListener(
            'scroll',
            () => {
              const viewportTop = element.getBoundingClientRect().top;
              const anchorElement = [
                ...element.querySelectorAll<HTMLElement>('article.message'),
              ].find((candidate) => candidate.getBoundingClientRect().bottom >= viewportTop);
              if (!anchorElement?.dataset.messageId) {
                reject(new Error('Could not find the visible history anchor'));
                return;
              }
              resolve({
                id: anchorElement.dataset.messageId,
                offset: anchorElement.getBoundingClientRect().top - viewportTop,
              });
            },
            { once: true },
          );
          element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
          element.scrollTop = 0;
        }),
    );
    await expect.poll(() => page.locator('article.message').count()).toBeGreaterThan(50);
    await expect(
      page.getByTestId('message-scroller').getByText('Newest message from fixture'),
    ).toBeAttached();
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const anchorElement = page.locator(`article[data-message-id="${anchor.id}"]`);
    await expect
      .poll(async () => {
        const anchorOffsetAfter = await anchorElement.evaluate(
          (element, scrollElement) =>
            element.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top,
          await scroller.elementHandle(),
        );
        return Math.abs(anchorOffsetAfter - anchor.offset);
      })
      .toBeLessThan(3);
  });
  await test.step('shows top-message delivery state and labels media dialogs as non-empty', async () => {
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
});

test('renders a prepended channel history page without losing its message layouts', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/?scenario=long-channel-history');
  await expect(page.getByTestId('chat-list')).toBeVisible();
  await expect(page.getByText('Fetching current chats')).toHaveCount(0);
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Release Channel/ })
    .click();
  const scroller = page.getByTestId('message-scroller');
  await expect(scroller.getByText('Channel history message 100', { exact: true })).toBeVisible();
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Alice Fixture/ })
    .click();
  await expect(scroller.getByText('Newest message from fixture', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const fixture = window.__televechaFixture;
    if (!fixture) throw new Error('Fixture transport is unavailable');
    for (let id = 101; id <= 103; id += 1) {
      fixture.emit({
        type: 'new-message',
        pts: 10 + id,
        ptsCount: 1,
        channelScoped: true,
        message: {
          id,
          peerId: 'c:202',
          senderId: 'u:404',
          senderName: 'Release Author',
          text: `Channel history message ${id}`,
          date: 1_700_000_000 + id,
          outgoing: false,
        },
      });
    }
  });
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Release Channel/ })
    .click();

  await expect(scroller.getByText('Channel history message 100', { exact: true })).toBeAttached();
  expect(pageErrors).toEqual([]);
});

test('centers the empty-conversation state independently of message padding', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'delete-messages',
      pts: 11,
      ptsCount: 1,
      peerId: 'u:101',
      messageIds: Array.from({ length: 50 }, (_, index) => index + 31),
    }),
  );
  const empty = page.getByRole('heading', { name: 'No messages yet' });
  await expect(empty).toBeVisible();
  await expect(page.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);
  const offset = await page.getByTestId('message-scroller').evaluate((element) => {
    const state = element.querySelector<HTMLElement>('h2')!;
    const viewport = element.getBoundingClientRect();
    const bounds = state.parentElement!.getBoundingClientRect();
    return bounds.top + bounds.height / 2 - (viewport.top + viewport.height / 2);
  });
  expect(Math.abs(offset)).toBeLessThan(2);

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 12,
      ptsCount: 1,
      message: {
        id: 181,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'First message after empty history',
        date: 1_700_003_181,
        outgoing: false,
      },
    }),
  );
  await expect(page.locator('article[data-message-id="181"]')).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByTestId('message-scroller')
        .evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight),
    )
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);
});

test('lays out an opened conversation, its details and its composer', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('does not flicker back to an empty conversation', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(await page.locator('article.message').count()).toBeGreaterThan(0);
      await page.waitForTimeout(25);
    }
    await expect(page.getByText('Start the conversation')).toHaveCount(0);
  });
  await test.step('renders real previews, avatars, a contained layout, and a visible composer', async () => {
    const alice = page
      .locator('[data-testid="chat-list"]')
      .getByRole('button', { name: /Alice Fixture/ });
    await expect(alice).toContainText('Newest message from fixture');
    await expect(alice).not.toContainText('No messages yet');
    await expect(alice.locator('img')).toBeVisible();

    const layout = await page.evaluate(() => {
      const chatList = document.querySelector<HTMLElement>('[data-testid="chat-list"]')!;
      const messages = document.querySelector<HTMLElement>('[data-testid="message-scroller"]')!;
      const composer = document.querySelector<HTMLElement>('textarea[aria-label="Message"]')!;
      return {
        documentFits:
          document.documentElement.scrollHeight === document.documentElement.clientHeight,
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
  await test.step('keeps outgoing message bubbles readable and distinct from incoming messages', async () => {
    const colors = await page.evaluate(() => {
      const readStyle = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          color: (style.color.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number),
        };
      };
      return { incoming: readStyle('.message.incoming'), outgoing: readStyle('.message.outgoing') };
    });
    const average = (rgb: number[]) => rgb.reduce((sum, channel) => sum + channel, 0) / rgb.length;

    expect(colors.outgoing.backgroundImage).not.toBe('none');
    expect(colors.outgoing.backgroundImage).not.toBe(colors.incoming.backgroundImage);
    expect(colors.outgoing.backgroundColor).not.toBe(colors.incoming.backgroundColor);
    expect(average(colors.outgoing.color)).toBeLessThan(235);
  });
  await test.step('never overlaps adjacent message rows in normal document flow', async () => {
    const overlaps = await page.getByTestId('message-scroller').evaluate((element) => {
      const rows = [...element.querySelectorAll<HTMLElement>('.message-flow-row:not([hidden])')];
      return rows.slice(1).flatMap((row, index) => {
        const previous = rows[index]!;
        return row.getBoundingClientRect().top < previous.getBoundingClientRect().bottom
          ? [
              {
                previous: previous.querySelector('article')?.getAttribute('data-message-id'),
                current: row.querySelector('article')?.getAttribute('data-message-id'),
              },
            ]
          : [];
      });
    });
    expect(overlaps).toEqual([]);
  });
  await test.step('keeps the final message close to the composer without a synthetic bottom gap', async () => {
    const gap = await page.getByTestId('message-scroller').evaluate((element) => {
      const rows = element.querySelectorAll<HTMLElement>('.message-flow-row:not([hidden])');
      const message = rows[rows.length - 1]?.querySelector<HTMLElement>('article.message');
      if (!message) throw new Error('Final message is missing');
      return element.getBoundingClientRect().bottom - message.getBoundingClientRect().bottom;
    });
    expect(gap).toBeLessThan(10);
  });
  await test.step('shows a chat scrollbar and jumps back to the present', async () => {
    const scroller = page.getByTestId('message-scroller');
    await expect(page.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);
    expect(await scroller.evaluate((element) => getComputedStyle(element).overflowAnchor)).toBe(
      'none',
    );
    expect(
      await scroller
        .locator('.present-scroll-anchor')
        .evaluate((element) => getComputedStyle(element).position),
    ).toBe('absolute');
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
          (element) => element.scrollTop + element.clientHeight >= element.scrollHeight,
        ),
      )
      .toBe(true);
    await expect(jump).toHaveCount(0);

    await page.mouse.wheel(0, -600);
    await expect(jump).toBeVisible();
    await page.mouse.wheel(0, 10_000);
    await expect(jump).toHaveCount(0);
  });
  await test.step('loads shared-media totals for the restored dialog without switching dialogs', async () => {
    await page.reload();

    await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');
    await expect(
      page.locator('aside.details-pane').getByRole('button', { name: 'Photos 128' }),
    ).toBeVisible();
  });
  await test.step('keeps the last bubble above the composer when the composer grows', async () => {
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
  await test.step('uses global media totals and only renders working details controls', async () => {
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
});
