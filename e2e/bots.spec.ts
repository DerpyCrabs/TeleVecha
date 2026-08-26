import { expect, test } from '@playwright/test';

import type { TransportUpdate } from '../src/telegram/types';
import { fixtureStats, openReady } from './helpers';

test('starts and restarts bots, sends commands, and handles bot keyboards', async ({ page }) => {
  await openReady(page);
  await page.getByRole('textbox', { name: 'Search chats' }).fill('helper');
  await page.getByTestId('peer-search-result').filter({ hasText: 'Fixture Helper Bot' }).click();

  await page.getByRole('button', { name: 'Start bot' }).click();
  await expect(page.getByTestId('message-scroller')).toContainText('/start');
  await expect(page.getByTestId('reply-bot-keyboard')).toBeVisible();
  await expect(page.getByTestId('inline-bot-keyboard')).toBeVisible();

  await page.getByRole('button', { name: 'Commands' }).click();
  await page.getByRole('menuitem', { name: /\/help.*Show available commands/ }).click();
  await expect(page.getByTestId('message-scroller')).toContainText('/help');

  await page.getByTestId('reply-bot-keyboard').getByRole('button', { name: 'Status' }).click();
  await expect(page.getByTestId('message-scroller')).toContainText('Status');

  await page.getByTestId('inline-bot-keyboard').getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('.bot-callback-notice')).toContainText('Fixture callback complete.');

  await page.getByRole('button', { name: 'Commands' }).click();
  await page.getByRole('menuitem', { name: 'Restart bot' }).click();

  await expect
    .poll(async () => {
      const stats = await fixtureStats(page);
      return {
        commands: stats?.getBotCommands,
        starts: stats?.startBot,
        callbacks: stats?.answerBotCallback,
        messages: stats?.sendText,
      };
    })
    .toEqual({ commands: 1, starts: 2, callbacks: 1, messages: 2 });
});

test('reloads commands when Telegram invalidates the active bot command list', async ({ page }) => {
  await openReady(page);
  await page.getByRole('textbox', { name: 'Search chats' }).fill('helper');
  await page.getByTestId('peer-search-result').filter({ hasText: 'Fixture Helper Bot' }).click();
  await page.getByRole('button', { name: 'Start bot' }).click();
  await page.getByRole('button', { name: 'Commands' }).click();
  await expect.poll(async () => (await fixtureStats(page))?.getBotCommands).toBe(1);

  await page.evaluate(() => {
    const fixture = window.__televechaFixture;
    if (!fixture) throw new Error('Fixture transport is unavailable');
    fixture.emit({ type: 'bot-commands-changed', peerId: 'u:606' });
  });

  await expect.poll(async () => (await fixtureStats(page))?.getBotCommands).toBe(2);
  await expect(
    page.getByRole('menuitem', { name: /\/help.*Show available commands/ }),
  ).toBeVisible();
});

test('renders reply keyboards in groups and honors force-reply, placeholder, and single-use', async ({
  page,
}) => {
  await openReady(page);
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Fixture Group/ })
    .click();
  await page.evaluate(() => {
    const fixture = window.__televechaFixture;
    if (!fixture) throw new Error('Fixture transport is unavailable');
    fixture.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 13,
        peerId: 'g:303',
        senderId: 'u:404',
        senderName: 'Fixture Author',
        text: 'Choose one response',
        date: Math.floor(Date.now() / 1000),
        outgoing: false,
        botKeyboard: {
          kind: 'reply',
          forceReply: true,
          singleUse: true,
          placeholder: 'Pick a group response',
          rows: [[{ kind: 'text', text: 'Acknowledge' }]],
        },
      },
    } satisfies TransportUpdate);
  });

  const keyboard = page.getByTestId('reply-bot-keyboard');
  await expect(keyboard).toBeVisible();
  await expect(page.getByTestId('composer-reply')).toContainText('Choose one response');
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAttribute(
    'placeholder',
    'Pick a group response',
  );
  await keyboard.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(keyboard).toHaveCount(0);
});

test('loads chat-scoped bot commands and addresses the selected bot in a group', async ({
  page,
}) => {
  await openReady(page);
  await page.evaluate(() => {
    const transport = window.__televechaRuntimes?.get('fixture:default')?.transport;
    if (!transport) throw new Error('Fixture transport is unavailable');
    const original = transport.getBotCommands?.bind(transport);
    transport.getBotCommands = async (peer) =>
      peer.id === 'g:303'
        ? [
            {
              command: 'status',
              description: 'Show group status',
              botId: 'u:606',
              botUsername: 'fixture_helper_bot',
              botName: 'Fixture Helper Bot',
            },
          ]
        : ((await original?.(peer)) ?? []);
  });
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Fixture Group/ })
    .click();

  await page.getByRole('button', { name: 'Commands' }).click();
  await page.getByRole('menuitem', { name: /\/status@fixture_helper_bot/ }).click();

  await expect(page.getByTestId('message-scroller')).toContainText('/status@fixture_helper_bot');
});

test('uses the originating bot for inline switches and supports choosing another chat', async ({
  page,
}) => {
  await openReady(page);
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Fixture Group/ })
    .click();
  await page.evaluate(() => {
    const fixture = window.__televechaFixture;
    if (!fixture) throw new Error('Fixture transport is unavailable');
    fixture.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 13,
        peerId: 'g:303',
        senderId: 'u:606',
        senderName: 'Fixture Helper Bot',
        text: 'Try an inline query',
        date: Math.floor(Date.now() / 1000),
        outgoing: false,
        botKeyboard: {
          kind: 'inline',
          rows: [
            [
              {
                kind: 'switch-inline',
                text: 'Use here',
                query: 'cats',
                samePeer: true,
                botUsername: 'fixture_helper_bot',
              },
              {
                kind: 'switch-inline',
                text: 'Choose chat',
                query: 'dogs',
                samePeer: false,
                botUsername: 'fixture_helper_bot',
              },
            ],
          ],
        },
      },
    } satisfies TransportUpdate);
  });

  const composer = page.getByRole('textbox', { name: 'Message' });
  await page.getByRole('button', { name: 'Use here' }).click();
  await expect(composer).toHaveValue('@fixture_helper_bot cats');
  await composer.fill('');

  await page.getByRole('button', { name: 'Choose chat' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a chat for inline query' });
  await picker.getByRole('button', { name: 'Alice Fixture' }).click();
  await expect(picker).toHaveCount(0);
  await expect(composer).toHaveValue('@fixture_helper_bot dogs');
});

test('keeps a large reply keyboard scrollable above the composer on mobile', async ({ page }) => {
  await openReady(page);
  await page.setViewportSize({ width: 390, height: 727 });
  await page.getByRole('button', { name: 'Open chat list' }).click();
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Fixture Group/ })
    .click();
  await page.evaluate(() => {
    const fixture = window.__televechaFixture;
    if (!fixture) throw new Error('Fixture transport is unavailable');
    fixture.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 13,
        peerId: 'g:303',
        senderId: 'u:404',
        text: 'Many choices',
        date: Math.floor(Date.now() / 1000),
        outgoing: false,
        botKeyboard: {
          kind: 'reply',
          rows: Array.from({ length: 30 }, (_, index) => [
            { kind: 'text' as const, text: `Choice ${index + 1}` },
          ]),
        },
      },
    } satisfies TransportUpdate);
  });

  const layout = await page.getByTestId('reply-bot-keyboard').evaluate((keyboard) => {
    const composer = document.querySelector<HTMLElement>('.chat-composer')!;
    return {
      keyboardClientHeight: keyboard.clientHeight,
      keyboardScrollHeight: keyboard.scrollHeight,
      composerBottom: composer.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(layout.keyboardScrollHeight).toBeGreaterThan(layout.keyboardClientHeight);
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
});

test('does not show a delayed callback answer in a different chat', async ({ page }) => {
  await openReady(page);
  await page.getByRole('textbox', { name: 'Search chats' }).fill('helper');
  await page.getByTestId('peer-search-result').filter({ hasText: 'Fixture Helper Bot' }).click();
  await page.getByRole('button', { name: 'Start bot' }).click();
  await page.evaluate(() => {
    const transport = window.__televechaRuntimes?.get('fixture:default')?.transport;
    if (!transport) throw new Error('Fixture transport is unavailable');
    const original = transport.answerBotCallback?.bind(transport);
    if (!original) throw new Error('Fixture callback support is unavailable');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    window.__releaseFixtureCallback = release;
    transport.answerBotCallback = async (peer, messageId, data) => {
      await held;
      return original(peer, messageId, data);
    };
  });

  await page.getByTestId('inline-bot-keyboard').getByRole('button', { name: 'Refresh' }).click();
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Alice Fixture/ })
    .click();
  await page.evaluate(() => window.__releaseFixtureCallback?.());
  await expect(page.locator('.bot-callback-notice')).toHaveCount(0);
});

test('asks for explicit consent before opening a URL-auth button', async ({ page }) => {
  await openReady(page);
  await page.evaluate(() => {
    const transport = window.__televechaRuntimes?.get('fixture:default')?.transport;
    if (!transport) throw new Error('Fixture transport is unavailable');
    const accept = transport.acceptUrlAuth?.bind(transport);
    if (!accept) throw new Error('Fixture URL authorization is unavailable');
    transport.requestUrlAuth = async () => ({
      kind: 'request',
      botTitle: 'Fixture Helper Bot',
      domain: 'example.com',
      requestWriteAccess: true,
      requestPhoneNumber: false,
      matchCodesFirst: true,
      isApp: true,
      matchCodes: ['F7Q2', 'L9M4'],
      verifiedAppName: 'Fixture Web App',
    });
    transport.acceptUrlAuth = async (peer, messageId, buttonId, options) => {
      window.__acceptedUrlAuthOptions = options ?? {};
      return accept(peer, messageId, buttonId, options);
    };
    window.open = ((url?: string | URL) => {
      window.__openedBotUrl = String(url ?? '');
      return window;
    }) as typeof window.open;
  });
  await page.getByRole('textbox', { name: 'Search chats' }).fill('helper');
  await page.getByTestId('peer-search-result').filter({ hasText: 'Fixture Helper Bot' }).click();
  await page.getByRole('button', { name: 'Start bot' }).click();
  await page.getByTestId('inline-bot-keyboard').getByRole('button', { name: 'Sign in' }).click();

  let consent = page.getByRole('dialog', { name: 'Sign in with Fixture Helper Bot' });
  await expect(consent).toContainText('example.com');
  await expect(consent).toContainText('Verified app: Fixture Web App');
  await consent.getByRole('button', { name: 'Cancel' }).click();
  await expect(consent).toHaveCount(0);
  expect(await page.evaluate(() => window.__openedBotUrl)).toBeUndefined();

  await page.getByTestId('inline-bot-keyboard').getByRole('button', { name: 'Sign in' }).click();
  consent = page.getByRole('dialog', { name: 'Sign in with Fixture Helper Bot' });
  const writeAccess = consent.getByRole('checkbox', {
    name: 'Allow Fixture Helper Bot to send me messages',
  });
  await expect(writeAccess).not.toBeChecked();
  await expect(consent.getByRole('checkbox', { name: /phone number/i })).toHaveCount(0);
  expect(await page.evaluate(() => window.__openedBotUrl)).toBeUndefined();

  const continueButton = consent.getByRole('button', { name: 'Continue to example.com' });
  await expect(continueButton).toBeDisabled();
  await consent.getByRole('radio', { name: 'L9M4' }).check();
  await writeAccess.check();
  await continueButton.click();
  await expect(consent).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__openedBotUrl))
    .toBe('https://example.com/authenticated');
  expect(await page.evaluate(() => window.__acceptedUrlAuthOptions)).toEqual({
    writeAllowed: true,
    matchCode: 'L9M4',
  });
});
