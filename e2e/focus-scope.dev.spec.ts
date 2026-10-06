import { test } from '@playwright/test';
import { expect } from './expect';

for (const destination of ['opener', 'another control', 'new scope'] as const) {
  test(`restores modal focus without overriding ${destination}`, async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('chat-list')).toBeVisible();
    const focused = await page.evaluate(async (destination) => {
      const { activateFocusScope } = await import('../src/ui/shared/focusScope');
      const opener = document.createElement('button');
      const other = document.createElement('button');
      const root = document.createElement('div');
      root.tabIndex = -1;
      document.body.append(opener, other, root);
      opener.focus();
      const release = activateFocusScope({ root, close: () => {} });
      await new Promise(requestAnimationFrame);

      const request = window.requestAnimationFrame;
      const frames: FrameRequestCallback[] = [];
      window.requestAnimationFrame = (callback) => {
        frames.push(callback);
        return -1;
      };
      let releaseNext: (() => void) | undefined;
      try {
        release();
        root.remove();
        if (destination === 'another control') other.focus();
        if (destination === 'new scope') {
          // A newer scope owns focus even before its initial-focus frame runs.
          releaseNext = activateFocusScope({ root: other, close: () => {} });
        }
        frames[0]!(performance.now());
        return {
          opener: document.activeElement === opener,
          other: document.activeElement === other,
        };
      } finally {
        window.requestAnimationFrame = request;
        releaseNext?.();
        opener.remove();
        other.remove();
        root.remove();
      }
    }, destination);
    expect(focused).toEqual({
      opener: destination === 'opener',
      other: destination === 'another control',
    });
  });
}
