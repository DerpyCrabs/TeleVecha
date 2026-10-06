import { test } from '@playwright/test';
import { expect } from './expect';

import { chatButton, fixtureStats, openReady, selectAlice } from './helpers';

test('sends with Enter and keeps drafts per chat and across reload', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('sends with Enter but keeps a newline with Shift+Enter', async () => {
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('first');
    await composer.press('Shift+Enter');
    await composer.type('second');
    await expect(composer).toHaveValue('first\nsecond');
    await composer.press('Enter');

    await expect(page.locator('article.message', { hasText: 'first\nsecond' })).toBeVisible();
    await expect.poll(() => fixtureStats(page).then((stats) => stats?.sendText)).toBe(1);
  });
  await test.step('keeps independent drafts per chat', async () => {
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('Alice draft');
    await chatButton(page, /Release Channel/).click();
    await expect(composer).toHaveValue('');
    await composer.fill('Release draft');

    await chatButton(page, /Alice Fixture/).click();
    await expect(composer).toHaveValue('Alice draft');
    await chatButton(page, /Release Channel/).click();
    await expect(composer).toHaveValue('Release draft');
  });
});

test('sends text messages and shows their delivery state', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('does not send blank text and disables the send button', async () => {
    const send = page.getByRole('button', { name: 'Send message' });
    await expect(send).toBeDisabled();
    await page.getByRole('textbox', { name: 'Message' }).fill('   ');
    await expect(send).toBeDisabled();
    expect((await fixtureStats(page))?.sendText).toBe(0);
  });
  await test.step('changes an outgoing message from sent to read after an outbox receipt', async () => {
    const outgoing = page.locator('article[data-message-id="80"]');
    await expect(outgoing.locator('footer')).toHaveAttribute(
      'aria-label',
      /Message status: sent$/u,
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
    await expect(outgoing.locator('footer')).toHaveAttribute(
      'aria-label',
      /Message status: read$/u,
    );
  });
  await test.step('sends a message with the send button and updates the chat preview', async () => {
    await page.getByRole('textbox', { name: 'Message' }).fill('Sent from the fixture');
    await page.getByRole('button', { name: 'Send message' }).click();

    const message = page.locator('article.message', { hasText: 'Sent from the fixture' });
    await expect(message).toBeVisible();
    await expect(message.locator('footer')).toHaveAttribute('aria-label', /Message status: sent$/u);
    await expect(chatButton(page, /Alice Fixture/)).toContainText('Sent from the fixture');
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    expect((await fixtureStats(page))?.sendText).toBe(1);
  });
  await test.step('places a text message time beside its final line without overlapping the text', async () => {
    await page.getByRole('textbox', { name: 'Message' }).fill('Side by side');
    await page.getByRole('button', { name: 'Send message' }).click();

    const message = page.locator('article.message', { hasText: 'Side by side' });
    await expect(message).toHaveClass(/message-inline-time/u);
    const geometry = await message.evaluate((element) => {
      const body = element.querySelector<HTMLElement>('.message-body')!;
      const footer = element.querySelector<HTMLElement>('footer')!;
      const range = document.createRange();
      range.selectNodeContents(body);
      const textRects = [...range.getClientRects()];
      const text = textRects.at(-1)!;
      const time = footer.getBoundingClientRect();
      return {
        articleHeight: element.getBoundingClientRect().height,
        bodyDisplay: getComputedStyle(body).display,
        footerPosition: getComputedStyle(footer).position,
        footerPaddingTop: getComputedStyle(footer).paddingTop,
        footerFloat: getComputedStyle(footer).float,
        horizontalGap: time.left - text.right,
        verticalOverlap: Math.min(text.bottom, time.bottom) - Math.max(text.top, time.top),
      };
    });
    expect(geometry.bodyDisplay).toBe('inline');
    expect(geometry.footerPosition).toBe('static');
    expect(geometry.footerPaddingTop).toBe('8px');
    expect(geometry.footerFloat).toBe('right');
    expect(geometry.horizontalGap).toBeGreaterThan(4);
    expect(geometry.verticalOverlap).toBeGreaterThan(0);
    expect(geometry.articleHeight).toBeLessThan(42);

    const wrappedText =
      'This deliberately long text message checks that a timestamp can sit beside the final words without obscuring any part of a message when the bubble wraps across several lines. '.repeat(
        3,
      );
    await page.getByRole('textbox', { name: 'Message' }).fill(wrappedText);
    await page.getByRole('button', { name: 'Send message' }).click();
    const wrapped = page.locator('article.message', { hasText: wrappedText });
    await expect(wrapped).toHaveClass(/message-inline-time/u);
    const wrappedGeometry = await wrapped.evaluate((element) => {
      const body = element.querySelector<HTMLElement>('.message-body')!;
      const footer = element.querySelector<HTMLElement>('footer')!;
      const range = document.createRange();
      range.selectNodeContents(body);
      const textRects = [...range.getClientRects()];
      const time = footer.getBoundingClientRect();
      return {
        lineCount: textRects.length,
        overlapsTime: textRects.some(
          (text) =>
            Math.min(text.right, time.right) > Math.max(text.left, time.left) &&
            Math.min(text.bottom, time.bottom) > Math.max(text.top, time.top),
        ),
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
      };
    });
    expect(wrappedGeometry.lineCount).toBeGreaterThan(1);
    expect(wrappedGeometry.overlapsTime).toBe(false);
    expect(wrappedGeometry.hasHorizontalOverflow).toBe(false);

    await page.setViewportSize({ width: 393, height: 851 });
    const mobileGeometry = await wrapped.evaluate((element) => {
      const body = element.querySelector<HTMLElement>('.message-body')!;
      const footer = element.querySelector<HTMLElement>('footer')!;
      const range = document.createRange();
      range.selectNodeContents(body);
      const textRects = [...range.getClientRects()];
      const time = footer.getBoundingClientRect();
      return {
        overlapsTime: textRects.some(
          (text) =>
            Math.min(text.right, time.right) > Math.max(text.left, time.left) &&
            Math.min(text.bottom, time.bottom) > Math.max(text.top, time.top),
        ),
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
        insideViewport: element.getBoundingClientRect().right <= window.innerWidth,
      };
    });
    expect(mobileGeometry).toEqual({
      overlapsTime: false,
      hasHorizontalOverflow: false,
      insideViewport: true,
    });
  });
});

test('keeps a failed message in the durable outbox with a visible failure state', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  await page.getByRole('textbox', { name: 'Message' }).fill('FAIL');
  await page.getByRole('button', { name: 'Send message' }).click();

  const failed = page.locator('article.message', { hasText: 'FAIL' });
  await expect(failed.locator('footer')).toHaveAttribute('aria-label', /Message status: failed$/u);
  await expect(page.getByText(/A message remains queued for retry/)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open('televecha-e2e');
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return new Promise<number>((resolve, reject) => {
          const count = database.transaction('outbox').objectStore('outbox').count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(count.error);
        });
      }),
    )
    .toBe(1);

  await failed.getByRole('button', { name: 'Retry' }).click();
  await expect(failed.locator('footer')).toHaveAttribute('aria-label', /Message status: failed$/u);
  await expect.poll(async () => (await fixtureStats(page))?.sendText).toBe(2);

  await failed.getByRole('button', { name: 'Cancel' }).click();
  await expect(failed).toHaveCount(0);
  await expect(page.getByText(/A message remains queued for retry/)).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open('televecha-e2e');
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return new Promise<number>((resolve, reject) => {
          const count = database.transaction('outbox').objectStore('outbox').count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(count.error);
        });
      }),
    )
    .toBe(0);
});

test('refreshes a missed outgoing read receipt when the app regains focus', async ({ page }) => {
  await openReady(page, '/?scenario=missed-read-receipt');
  await selectAlice(page);
  const outgoing = page.locator('article[data-message-id="80"]');
  await expect(outgoing.locator('footer')).toHaveAttribute('aria-label', /Message status: sent$/u);

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect(outgoing.locator('footer')).toHaveAttribute('aria-label', /Message status: read$/u);
  expect((await fixtureStats(page))?.getReadOutboxMaxId).toBe(1);
});

test('persists the current draft and active chat across reload', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await chatButton(page, /Release Channel/).click();
  await expect(page.getByTestId('conversation-header')).toContainText('Release Channel');
  // The chat enters the URL once its conversation has opened; reload only after that.
  await expect(page).toHaveURL(/chat=c%3A202/u);
  await page.getByRole('textbox', { name: 'Message' }).fill('Persistent draft');
  await page.reload();

  await expect(page.getByTestId('conversation-header')).toContainText('Release Channel');
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Persistent draft');
});
