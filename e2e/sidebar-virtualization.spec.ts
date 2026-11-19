import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, releaseHeldConnect } from './helpers';

import type { TelegramDialog } from '../src/telegram/types';
test('virtualizes a complete dialog list and reuses avatar observation', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeIntersectionObserver = window.IntersectionObserver;
    class CountingIntersectionObserver extends NativeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback, options);
        window.__intersectionObserverConstructions =
          (window.__intersectionObserverConstructions ?? 0) + 1;
      }
    }
    window.IntersectionObserver = CountingIntersectionObserver;
  });
  await page.goto('/?scenario=held-connect');
  await expect(page.getByText('Connecting to Telegram')).toBeVisible();
  await releaseHeldConnect(page);
  await expect(page.getByText('Connecting to Telegram')).toHaveCount(0);
  await expect(page.getByTestId('chat-list')).toBeVisible();
  const observersBefore =
    (await page.evaluate(() => window.__intersectionObserverConstructions)) ?? 0;

  await page.evaluate(async () => {
    const opened = indexedDB.open('televecha-e2e-held-connect');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
    const template = await new Promise<TelegramDialog | undefined>((resolve, reject) => {
      const request = database.transaction('dialogs').objectStore('dialogs').getAll();
      request.onsuccess = () => resolve((request.result as TelegramDialog[])[0]);
      request.onerror = () => reject(request.error);
    });
    if (!template) throw new Error('Fixture dialog is unavailable');
    const synthetic: TelegramDialog[] = Array.from({ length: 1_997 }, (_, index) => ({
      ...template,
      peer: { id: `u:virtual-${index}`, kind: 'user', accessHash: String(index + 10_000) },
      title: `Virtual chat ${index + 1}`,
      initials: `V${(index + 1) % 10}`,
      hasAvatar: false,
      avatarId: `virtual-${index}`,
      topMessage: {
        id: index + 1,
        peerId: `u:virtual-${index}`,
        senderId: `u:virtual-${index}`,
        text: `Virtual preview ${index + 1}`,
        date: 1_600_000_000 - index,
        outgoing: false,
      },
    }));
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('dialogs', 'readwrite');
      const store = transaction.objectStore('dialogs');
      for (const dialog of synthetic) store.put(dialog);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  });
  await page.goto('/?scenario=held-connect');
  await expect(page.getByTestId('chat-list')).toBeVisible();

  const list = page.getByTestId('chat-list');
  const rows = list.locator('.chat-row');
  await expect.poll(() => rows.count()).toBeLessThan(80);
  await expect(rows).not.toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__intersectionObserverConstructions ?? 0))
    .toBeLessThanOrEqual(observersBefore + 1);

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(list.getByText('Virtual chat 1997', { exact: true })).toBeVisible();
  await expect.poll(() => rows.count()).toBeLessThan(80);
});

test('follows an outgoing chat beyond the virtualized viewport', async ({ page }) => {
  await openReady(page);
  await page.evaluate(() => {
    const runtime = [...window.__televechaRuntimes!.values()][0]!;
    const template = runtime.engine.snapshot().dialogs.find((d) => d.peer.id === 'u:101')!;
    for (let i = 1; i <= 130; i++) {
      window.__televechaFixture!.emit({
        type: 'dialog-changed',
        dialog: {
          ...template,
          peer: { kind: 'user', id: 'u:' + (10000 + i) },
          title: 'Scroll chat ' + i,
          topMessageId: 0,
          topMessage: undefined,
          pinned: false,
          hasAvatar: false,
        },
      });
    }
  });
  const list = page.getByTestId('chat-list');
  await expect(list.locator('.chat-row').first()).toHaveAttribute('aria-setsize', '133');
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const lastChat = list.locator('.chat-row[aria-posinset="133"]');
  await lastChat.click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Move this chat to the top');
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
  await composer.press('Enter');
  await expect(list.locator('.chat-row.active')).toContainText('Move this chat to the top');
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeLessThan(65);
  await expect(list.locator('.chat-row.active')).toBeInViewport();
});
