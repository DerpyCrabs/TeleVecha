import { test } from '@playwright/test';
import { expect } from './expect';

import { chatButton, fixtureStats, openReady, selectAlice } from './helpers';

test('opens at the first unread message and drops the divider at the present', async ({ page }) => {
  await test.step('opens a chat at the first unread message instead of the latest message', async () => {
    await openReady(page, '/?scenario=unread-history');

    const longHistory = chatButton(page, /Long History/);
    await expect(longHistory).toHaveAccessibleName(/15 unread messages/);
    await longHistory.click();

    const scroller = page.getByTestId('message-scroller');
    const firstUnread = page.locator('article[data-message-id="972"]');
    await expect(firstUnread).toBeAttached();
    await expect
      .poll(() =>
        firstUnread.evaluate((message) => {
          const viewport = message.closest<HTMLElement>('[data-testid="message-scroller"]');
          if (!viewport) throw new Error('Message viewport is missing');
          return message.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
        }),
      )
      .toBeGreaterThanOrEqual(0);
    await expect
      .poll(() =>
        firstUnread.evaluate((message) => {
          const viewport = message.closest<HTMLElement>('[data-testid="message-scroller"]')!;
          return message.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
        }),
      )
      .toBeLessThan(100);
    await expect(scroller).toContainText('Long history message 972');
    await expect(scroller.getByText('Unread messages')).toBeVisible();
  });
  await test.step('removes the unread divider after jumping to the present', async () => {
    await expect(page.getByText('Unread messages')).toBeVisible();

    await page.getByRole('button', { name: 'Jump to present' }).click();

    await expect(page.getByText('Unread messages')).toHaveCount(0);
  });
});

test('opens a chat with one unread message at the end of the conversation', async ({ page }) => {
  await openReady(page, '/?scenario=single-unread');
  await chatButton(page, /Alice Fixture/).click();

  const scroller = page.getByTestId('message-scroller');
  await expect(page.locator('article[data-message-id="80"]')).toBeVisible();
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect(page.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);
});

test('removes the unread divider after replying from the unread section', async ({ page }) => {
  await openReady(page, '/?scenario=unread-history');
  await chatButton(page, /Long History/).click();

  const firstUnread = page.locator('article[data-message-id="972"]');
  await firstUnread.hover();
  await firstUnread.getByRole('button', { name: 'Reply to message 972' }).click();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Read and replied');
  await composer.press('Enter');

  await expect(page.getByText('Unread messages')).toHaveCount(0);
});

test('keeps message actions reachable and the reply draft focused', async ({ page }) => {
  await test.step('keeps message actions visible while the pointer crosses the message-owned side area', async () => {
    await openReady(page);
    await selectAlice(page);

    const message = page.locator('article[data-message-id="79"]');
    const reply = message.getByRole('button', { name: 'Reply to message 79' });
    await message.hover();
    await expect(reply).toHaveCSS('opacity', '1');

    const corridor = await message.evaluate((article) => {
      const bubble = article.getBoundingClientRect();
      const action = article
        .querySelector<HTMLButtonElement>('.add-reaction')!
        .getBoundingClientRect();
      return { x: (bubble.right + action.left) / 2, y: action.top + action.height / 2 };
    });
    await page.mouse.move(corridor.x, corridor.y);
    await page.waitForTimeout(150);

    await expect(reply).toHaveCSS('opacity', '1');
  });
  await test.step('leaves keyboard focus in the composer after choosing Reply with the mouse', async () => {
    const message = page.locator('article[data-message-id="79"]');
    await message.hover();
    await message.getByRole('button', { name: 'Reply to message 79' }).click();

    const composer = page.getByRole('textbox', { name: 'Message' });
    await expect(page.getByTestId('composer-reply')).toBeVisible();
    await expect(composer).toBeFocused();
    await page.keyboard.type('Reply without refocusing');
    await expect(composer).toHaveValue('Reply without refocusing');
  });
  await page.getByRole('textbox', { name: 'Message' }).fill('');
  await test.step('keeps a reply draft focused through a burst of Telegram updates', async () => {
    const message = page.locator('article[data-message-id="79"]');
    await message.hover();
    await message.getByRole('button', { name: 'Reply to message 79' }).click();
    const composer = page.getByRole('textbox', { name: 'Message' });
    await expect(composer).toBeFocused();
    await composer.evaluate((element) => {
      element.dataset.focusProbe = 'same-composer';
    });

    await page.evaluate(() => {
      window.__televechaFixture?.emit({
        type: 'presence-changed',
        peerId: 'u:101',
        presence: 'online',
      });
      window.__televechaFixture?.emit({
        type: 'read-history',
        pts: 11,
        ptsCount: 1,
        peerId: 'u:101',
        maxMessageId: 80,
        direction: 'outbox',
      });
      window.__televechaFixture?.emit({
        type: 'new-message',
        pts: 12,
        ptsCount: 1,
        message: {
          id: 13,
          peerId: 'g:303',
          senderId: 'u:404',
          text: 'Unrelated synchronized message',
          date: 1_700_003_000,
          outgoing: false,
        },
      });
      window.__televechaFixture?.emit({
        type: 'new-message',
        pts: 13,
        ptsCount: 1,
        message: {
          id: 81,
          peerId: 'u:101',
          senderId: 'u:101',
          text: 'Active synchronized message',
          date: 1_700_003_001,
          outgoing: false,
        },
      });
    });

    await expect(page.locator('article[data-message-id="81"]')).toBeAttached();
    await expect(composer).toHaveAttribute('data-focus-probe', 'same-composer');
    await expect(composer).toBeFocused();
    await page.keyboard.type('Typed after synchronization');
    await expect(composer).toHaveValue('Typed after synchronization');
  });
});

test('renders a second outgoing message while the first send is still pending', async ({
  page,
}) => {
  await openReady(page, '/?scenario=held-send&chat=u%3A101');
  await selectAlice(page);
  const composer = page.getByRole('textbox', { name: 'Message' });

  await composer.fill('First pending message');
  await composer.press('Enter');
  await expect(page.locator('article.message', { hasText: 'First pending message' })).toBeVisible();

  await composer.fill('Second pending message');
  await composer.press('Enter');

  await expect(
    page.locator('article.message', { hasText: 'Second pending message' }),
  ).toBeVisible();
  expect((await fixtureStats(page))?.sendText).toBe(1);
  await expect(
    page.locator('article.message').filter({ has: page.locator('.lucide-clock-3') }),
  ).toHaveCount(2);
});
