import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';

test('transitions expression pages and sticker packs, then dismisses and reopens the picker', async ({
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  const trigger = page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' });
  await trigger.click();
  const picker = page.locator('.expression-picker');
  await expect(picker).toHaveCSS('animation-name', 'menu-enter');
  const gif = picker.getByRole('button', { name: 'GIFs', exact: true });
  const changed = await gif.evaluate(async (button) => {
    (button as HTMLButtonElement).click();
    await new Promise(requestAnimationFrame);
    return document
      .querySelector('.expression-content')
      ?.getAnimations()
      .some((a) => a.id === 'picker-page');
  });
  expect(changed).toBe(true);
  await picker.getByRole('button', { name: 'Stickers', exact: true }).click();
  const pack = picker
    .locator('.sticker-pack-tabs button:not(.active):not(.sticker-manage-packs)')
    .first();
  const packChanged = await pack.evaluate(async (button) => {
    (button as HTMLButtonElement).click();
    await new Promise(requestAnimationFrame);
    return document
      .querySelector('.sticker-pack-grid')
      ?.getAnimations()
      .some((a) => a.id === 'picker-page');
  });
  expect(packChanged).toBe(true);
  const exit = await trigger.evaluate(async (button) => {
    (button as HTMLButtonElement).click();
    await new Promise(requestAnimationFrame);
    const surface = document.querySelector('.expression-picker')!;
    return [getComputedStyle(surface).animationName, surface.closest('[inert]') !== null];
  });
  expect(exit).toEqual(['menu-exit', true]);
  await trigger.click();
  await expect(picker).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
});

test('animates live incoming and outgoing rows once and respects reduced motion', async ({
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  await expect(page.locator('.conversation-ready article').last()).toBeVisible();
  await page.evaluate(() => {
    const content = document.querySelector('.conversation-content')!;
    const seen = new WeakSet<Animation>();
    new MutationObserver(() => {
      for (const animation of content.getAnimations({ subtree: true })) {
        if (animation.id !== 'message-arrival' || seen.has(animation)) continue;
        seen.add(animation);
        const row = (animation.effect as KeyframeEffect).target;
        const message = row!.querySelector<HTMLElement>('article')!;
        message.dataset.arrivals = String(Number(message.dataset.arrivals ?? 0) + 1);
      }
    }).observe(content, { childList: true });
  });
  const receive = (id: number) =>
    page.evaluate(
      (id) =>
        window.__televechaFixture!.emit({
          type: 'new-message',
          pts: id - 70,
          ptsCount: 1,
          message: {
            id,
            peerId: 'u:101',
            senderId: 'u:101',
            text: 'Incoming ' + id,
            date: 1_770_002_000 + id,
            outgoing: false,
          },
        }),
      id,
    );
  await receive(81);
  await expect(page.locator('article[data-message-id="81"]')).toHaveAttribute('data-arrivals', '1');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Outgoing animation check');
  await input.press('Enter');
  const sent = page.locator('article.outgoing').filter({ hasText: 'Outgoing animation check' });
  await expect(sent).toHaveAttribute('data-arrivals', '1');
  await expect(sent).toHaveAttribute('data-message-id', /^\d+$/);
  await expect(sent).toHaveAttribute('data-arrivals', '1');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await receive(82);
  const reduced = page.locator('article[data-message-id="82"]').filter({ hasText: 'Incoming 82' });
  await expect(reduced).toBeVisible();
  await expect(reduced).not.toHaveAttribute('data-arrivals', '1');
});
