import { test } from '@playwright/test';
import { expect } from './expect';

import { fixtureStats, openReady, selectAlice } from './helpers';

test('changes themes, accents, wallpapers and font size from settings', async ({ page }) => {
  await openReady(page);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await test.step('does not show the removed saved Telegram themes catalog', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByText('Saved Telegram Desktop themes')).toHaveCount(0);
    await expect(settings.getByRole('button', { name: /Ocean Blue tinted/ })).toHaveCount(0);
  });
  await test.step('scrolls the settings content inside the dialog', async () => {
    const content = page.locator('.settings-dialog-content');
    await expect(content).toHaveCSS('overflow-y', 'auto');
    const dimensions = await content.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
    await content.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });
  await test.step('keeps chats plain by default and does not tile the optional doodle image', async () => {
    await expect(page.locator('html')).toHaveAttribute('data-wallpaper', 'none');
    await page.getByRole('button', { name: 'Doodles background' }).click();

    const wallpaper = page.locator('.chat-wallpaper');
    await expect(wallpaper).toHaveCSS('background-image', /telegram-doodles-dark[-\w]*\.png/);
    await expect(wallpaper).toHaveCSS('background-repeat', 'no-repeat');
    await expect(wallpaper).toHaveCSS('background-size', 'cover');
  });
  await test.step('matches Telegram Desktop base themes and accent controls', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings' });
    for (const name of ['Classic theme', 'Day theme', 'Tinted theme', 'Night theme']) {
      await expect(settings.getByRole('button', { name })).toBeVisible();
    }
    await expect(settings.getByRole('button', { name: 'Violet theme' })).toHaveCount(0);

    await settings.getByRole('button', { name: 'Accent #4fa45f' }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        ),
      )
      .toBe('#4fa45f');
    await settings.getByLabel('System accent color').check();
    await expect(settings.getByLabel('System accent color')).toBeChecked();
  });
  await test.step('downloads a Telegram wallpaper but never installs it in the account', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings' });
    const wallpaper = settings.getByRole('button', { name: 'Telegram background fixture-lagoon' });
    await expect(wallpaper).toBeVisible();
    await wallpaper.click();

    await expect(page.locator('html')).toHaveAttribute('data-wallpaper', 'telegram');
    await expect
      .poll(() => fixtureStats(page).then((stats) => stats?.downloadWallpaper ?? 0))
      .toBe(1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue('--wallpaper-asset').startsWith('url('),
        ),
      )
      .toBe(true);
  });
  await test.step('applies and persists local themes and chat backgrounds', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Day theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
    await expect(page.locator('html')).toHaveAttribute('data-theme-source', 'day');

    await settings.getByRole('button', { name: 'Aurora background' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-wallpaper', 'aurora');
    await expect(page.locator('.chat-wallpaper')).toHaveCSS('background-image', /gradient/);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
    await expect(page.locator('html')).toHaveAttribute('data-wallpaper', 'aurora');
  });
  await page.getByRole('button', { name: 'Open settings' }).click();
  await test.step('changes and persists message font size without resizing interface text', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings' });
    const settingsTitle = settings.getByText('Settings', { exact: true });
    const conversationTitle = page.getByTestId('conversation-header').locator('strong');
    const interfaceSizes = await Promise.all([
      settingsTitle.evaluate((element) => getComputedStyle(element).fontSize),
      conversationTitle.evaluate((element) => getComputedStyle(element).fontSize),
    ]);

    await settings.getByRole('slider', { name: 'Chat font size' }).fill('21');

    await expect(settings.getByText('21px', { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue('--chat-font-size').trim(),
        ),
      )
      .toBe('21px');
    await expect
      .poll(() =>
        Promise.all([
          settingsTitle.evaluate((element) => getComputedStyle(element).fontSize),
          conversationTitle.evaluate((element) => getComputedStyle(element).fontSize),
        ]),
      )
      .toEqual(interfaceSizes);

    await page.getByRole('button', { name: 'Close settings' }).click();
    await selectAlice(page);
    await expect(page.locator('article.message .message-body').last()).toHaveCSS(
      'font-size',
      '21px',
    );

    await page.reload();
    await expect(page.locator('article.message .message-body').last()).toHaveCSS(
      'font-size',
      '21px',
    );
  });
});

test('uses the background explicitly assigned to a chat', async ({ page }) => {
  await openReady(page);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>('.message-scroll-shell');
    const trackedWindow = window as typeof window & {
      __chatWallpaperTransitions?: Array<{
        wallpaper: string | null;
        pattern: string | null;
        asset: string;
        base: string;
      }>;
    };
    trackedWindow.__chatWallpaperTransitions = [];
    if (!target) return;
    new MutationObserver(() => {
      trackedWindow.__chatWallpaperTransitions!.push({
        wallpaper: target.getAttribute('data-chat-wallpaper'),
        pattern: target.getAttribute('data-chat-pattern'),
        asset: target.style.getPropertyValue('--chat-wallpaper-asset'),
        base: getComputedStyle(target.querySelector('.chat-wallpaper')!).backgroundImage,
      });
    }).observe(target, { attributes: true, attributeFilter: ['data-chat-wallpaper', 'style'] });
  });
  await selectAlice(page);

  const shell = page.locator('.message-scroll-shell');
  await expect(shell).toHaveAttribute('data-chat-theme', 'telegram');
  await expect(shell).toHaveAttribute('data-chat-wallpaper', 'telegram');
  await expect(shell).toHaveAttribute('data-chat-pattern', 'inverted');
  const appliedTransitions = await page.evaluate(() => {
    const trackedWindow = window as typeof window & {
      __chatWallpaperTransitions?: Array<{
        wallpaper: string | null;
        pattern: string | null;
        asset: string;
        base: string;
      }>;
    };
    return (trackedWindow.__chatWallpaperTransitions ?? []).filter(
      ({ wallpaper }) => wallpaper === 'telegram',
    );
  });
  expect(appliedTransitions.length).toBeGreaterThan(0);
  expect(
    appliedTransitions.every(
      ({ asset, pattern, base }) =>
        asset.startsWith('url("blob:') ||
        (pattern === 'inverted' && base === 'linear-gradient(rgb(5, 7, 6), rgb(5, 7, 6))'),
    ),
  ).toBe(true);
  await expect
    .poll(() =>
      shell.locator('.chat-wallpaper').evaluate((element) => {
        const pattern = getComputedStyle(element, '::before');
        return {
          background: pattern.backgroundImage,
          backgroundSize: pattern.backgroundSize,
          mask: pattern.maskImage,
          maskSize: pattern.maskSize,
          opacity: pattern.opacity,
          base: getComputedStyle(element).backgroundImage,
        };
      }),
    )
    .toEqual({
      background: expect.stringMatching(/gradient/),
      backgroundSize: expect.stringMatching(/^cover/),
      mask: expect.stringMatching(/^url\("blob:/),
      maskSize: expect.stringMatching(/^512px(?: auto)?$/),
      opacity: '0.6',
      base: 'linear-gradient(rgb(5, 7, 6), rgb(5, 7, 6))',
    });
  await expect(shell.locator('.message.outgoing').first()).toHaveCSS(
    'background-image',
    /gradient/,
  );
  await expect(shell.locator('.message.outgoing').first()).toHaveCSS('color', 'rgb(24, 33, 43)');
  await page.evaluate(() => {
    window.__televechaFixture?.emit({
      type: 'read-history',
      pts: 11,
      ptsCount: 1,
      peerId: 'u:101',
      maxMessageId: 80,
      direction: 'outbox',
    });
  });
  await expect(shell.locator('.message-status-read').first()).toHaveCSS(
    'color',
    'rgb(255, 255, 255)',
  );
  await expect(shell.locator('.message-forwarded-from').first()).toHaveCSS(
    'color',
    'rgb(86, 168, 232)',
  );

  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Release Channel/ })
    .click();
  await page.evaluate(() => {
    const trackedWindow = window as typeof window & { __chatWallpaperTransitions?: unknown[] };
    trackedWindow.__chatWallpaperTransitions = [];
  });
  await selectAlice(page);
  await expect(shell).toHaveAttribute('data-chat-pattern', 'inverted');
  const reopenedTransitions = await page.evaluate(() => {
    const trackedWindow = window as typeof window & {
      __chatWallpaperTransitions?: Array<{ wallpaper: string | null; asset: string }>;
    };
    return (trackedWindow.__chatWallpaperTransitions ?? []).filter(
      ({ wallpaper }) => wallpaper === 'telegram',
    );
  });
  expect(reopenedTransitions.length).toBeGreaterThan(0);
  expect(reopenedTransitions.every(({ asset }) => asset.startsWith('url("blob:'))).toBe(true);
  const stats = await fixtureStats(page);
  expect(stats?.getChatAppearance).toBe(2);
  expect(stats?.downloadWallpaper).toBe(1);
});
