import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, selectAlice } from './helpers';

test('keeps the outgoing attachment menu painted but inert, including a rapid reopen', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  const trigger = page.getByRole('button', { name: 'Attach files', exact: true });
  await trigger.click();
  const surface = page.getByRole('group', { name: 'Attach', exact: true });
  await expect(surface).toBeVisible();
  const sample = await trigger.evaluate(async (button) => {
    if (!(button instanceof HTMLButtonElement)) throw Error('Expected the attachment button');
    const menu = document.querySelector<HTMLElement>('.composer-attach-menu')!;
    button.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const exit = menu
      .getAnimations()
      .find(
        (animation) => animation instanceof CSSAnimation && animation.animationName === 'menu-exit',
      );
    if (!exit) return { inert: menu.inert };
    exit.pause();
    exit.currentTime = 60;
    const opacity = Number(getComputedStyle(menu).opacity);
    const inert = menu.inert;
    button.click();
    return { inert, opacity };
  });
  expect(sample.inert).toBe(true);
  expect(sample.opacity).toBeGreaterThan(0);
  expect(sample.opacity).toBeLessThan(1);
  await expect(surface).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.composer-attach-menu')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  await expect(surface).toHaveCSS('animation-name', 'none');
});

test('places a chat menu inside the viewport and aligns details actions to the same columns', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  await page
    .getByRole('button', { name: /Fixture Group,/ })
    .first()
    .click();
  const alignment = await page
    .locator('.details-pane .detail-row')
    .evaluateAll((rows) =>
      rows
        .slice(0, 3)
        .map((row) =>
          [...row.querySelectorAll('svg,span')]
            .slice(0, 2)
            .map((el) => el.getBoundingClientRect().left),
        ),
    );
  expect(alignment.length).toBe(3);
  expect(alignment[1]).toEqual(alignment[0]);
  expect(alignment[2]).toEqual(alignment[0]);
  await page
    .locator('.chat-row.active')
    .evaluate((row) =>
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: innerWidth - 1,
          clientY: innerHeight - 1,
        }),
      ),
    );
  const menu = page.getByRole('menu', { name: 'Chat actions' });
  const bounds = await menu.boundingBox();
  expect(bounds).toBeTruthy();
  expect(bounds!.x).toBeGreaterThanOrEqual(8);
  expect(bounds!.y).toBeGreaterThanOrEqual(8);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width - 8);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height - 8);
});
