import { expect, test } from '@playwright/test';

import type { EngineSnapshot, TelegramDialog } from '../src/telegram/types';
import { openReady } from './helpers';

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
  await openReady(page);
  const observersBefore =
    (await page.evaluate(() => window.__intersectionObserverConstructions)) ?? 0;

  await page.evaluate(() => {
    const engine = window.__televechaRuntimes?.get('fixture:default')?.engine;
    if (!engine) throw new Error('Fixture engine is unavailable');
    const current = engine.snapshot();
    const template = current.dialogs[0];
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
        date: 1_600_000_000 + index,
        outgoing: false,
      },
    }));
    (
      engine as unknown as {
        patch(next: Partial<EngineSnapshot>): void;
      }
    ).patch({ dialogs: [...current.dialogs, ...synthetic] });
  });

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
