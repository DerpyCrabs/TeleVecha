import { expect, test } from '@playwright/test';
import { openReady, selectAlice } from './helpers';

test('preserves search focus and typing when a deferred composer focus runs', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  const composer = page.getByRole('textbox', { name: 'Message' });
  const search = page.getByRole('textbox', { name: 'Search chats' });
  await composer.focus();

  // Hold animation frames without inspecting callback source or changing app code.
  const frames = await page.evaluateHandle(() => {
    const request = window.requestAnimationFrame;
    const cancel = window.cancelAnimationFrame;
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = -1;
    window.requestAnimationFrame = (callback) => {
      const id = nextId--;
      pending.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (!pending.delete(id)) cancel.call(window, id);
    };
    return {
      pending,
      release: () => {
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = cancel;
        const callbacks = [...pending.values()];
        pending.clear();
        for (const callback of callbacks) callback(performance.now());
      },
    };
  });

  try {
    // Editing requests composer focus in a microtask and again on the next frame.
    await composer.press('ArrowUp');
    await expect(page.getByTestId('composer-edit')).toBeVisible();
    await expect.poll(() => frames.evaluate(({ pending }) => pending.size)).toBeGreaterThan(0);
    const draftBefore = await composer.inputValue();
    await search.focus();
    await expect(search).toBeFocused();
    await frames.evaluate(({ release }) => release());
    // Keyboard typing deliberately does not focus its destination like locator.fill().
    await page.keyboard.type('helper');
    const [searchFocused, searchValue, composerValue] = await Promise.all([
      search.evaluate((element) => element === document.activeElement),
      search.inputValue(),
      composer.inputValue(),
    ]);
    expect({ searchFocused, searchValue, composerValue }).toEqual({
      searchFocused: true,
      searchValue: 'helper',
      composerValue: draftBefore,
    });
  } finally {
    await frames.evaluate(({ release }) => release());
    await frames.dispose();
  }
});
