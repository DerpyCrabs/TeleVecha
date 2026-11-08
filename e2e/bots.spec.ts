import { test } from '@playwright/test';
import { expect } from './expect';

import type { TransportUpdate } from '../src/telegram/types';
import { fixtureStats, openReady } from './helpers';

test('shows no bot commands in channels or in groups without published commands', async ({
  page,
}) => {
  await test.step('does not treat channels as bot-command chats', async () => {
    await openReady(page);
    await page
      .getByTestId('chat-list')
      .getByRole('button', { name: /Release Channel/ })
      .click();

    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveCount(0);
    await expect(page.locator('.bot-command-bar')).toHaveCount(0);
    await expect(page.locator('.message-sender-avatar')).toHaveCount(1);
    await expect(page.locator('.message-sender-avatar img')).toBeVisible();
    const members = page.locator('.group-members');
    await expect(members).toContainText('Fixture Author');
    await expect(members).toContainText('Another Member');
    await expect(members.locator('.member-role.owner')).toHaveText('owner');
    await expect(members.locator('.member-role.admin')).toHaveText('moderator');
    const owner = members.locator('.group-member').filter({ hasText: 'Fixture Author' });
    await expect(owner.locator('small')).toHaveText('online');
    await expect(owner.getByText('owner', { exact: true })).toHaveCount(1);
    const detailsOrder = await page.locator('.details-pane').evaluate((details) => {
      const links = [...details.querySelectorAll('.detail-row')].at(-1)?.getBoundingClientRect();
      const membersBox = details.querySelector('.group-members')?.getBoundingClientRect();
      if (!links || !membersBox) throw new Error('Details sections are missing');
      return membersBox.top >= links.bottom;
    });
    expect(detailsOrder).toBe(true);
    expect((await fixtureStats(page))?.getBotCommands).toBe(0);
  });
  await test.step('does not show bot commands in an ordinary group without published commands', async () => {
    await page.evaluate(() => {
      window.__televechaFixture?.setBotCommands('g:303', []);
    });
    await page
      .getByTestId('chat-list')
      .getByRole('button', { name: /Fixture Group/ })
      .click();

    await expect.poll(async () => (await fixtureStats(page))?.getBotCommands).toBe(1);
    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveCount(0);
    await expect(page.locator('.bot-command-bar')).toHaveCount(0);
  });
});

test('groups channel posts by author and keeps the avatar on the last post', async ({ page }) => {
  await openReady(page);
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Release Channel/ })
    .click();

  await page.evaluate(() => {
    const fixture = window.__televechaFixture;
    if (!fixture) throw new Error('Fixture transport is unavailable');
    const date = 1_700_001_001;
    fixture.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      channelScoped: true,
      message: {
        id: 6,
        peerId: 'c:202',
        senderId: 'u:404',
        senderName: 'Release Author',
        senderHasAvatar: true,
        senderAvatarId: 'fixture-u:404',
        senderColor: '#408acf',
        senderColorVersion: 2,
        senderRole: 'owner',
        senderRoleKind: 'owner',
        text: 'Follow-up one',
        date,
        outgoing: false,
      },
    } satisfies TransportUpdate);
    fixture.emit({
      type: 'new-message',
      pts: 12,
      ptsCount: 1,
      channelScoped: true,
      message: {
        id: 7,
        peerId: 'c:202',
        senderId: 'u:404',
        senderName: 'Release Author',
        senderHasAvatar: true,
        senderAvatarId: 'fixture-u:404',
        senderColor: '#408acf',
        senderColorVersion: 2,
        senderRole: 'owner',
        senderRoleKind: 'owner',
        text: 'Follow-up two',
        date: date + 1,
        outgoing: false,
      },
    } satisfies TransportUpdate);
    fixture.emit({
      type: 'new-message',
      pts: 13,
      ptsCount: 1,
      channelScoped: true,
      message: {
        id: 8,
        peerId: 'c:202',
        senderId: 'u:405',
        senderName: 'Another Author',
        senderColor: '#d95574',
        senderColorVersion: 2,
        senderRole: 'moderator',
        senderRoleKind: 'admin',
        text: 'Different author',
        date: date + 2,
        outgoing: false,
      },
    } satisfies TransportUpdate);
  });

  const runStart = page.locator('[data-message-id="5"]');
  const first = page.locator('[data-message-id="6"]');
  const last = page.locator('[data-message-id="7"]');
  const different = page.locator('[data-message-id="8"]');
  await expect(first).toHaveClass(/message-same-sender/);
  await expect(last).toHaveClass(/message-same-sender/);
  await expect(different).not.toHaveClass(/message-same-sender/);
  await expect(first.locator('.message-sender-avatar')).toHaveCount(0);
  await expect(last.locator('.message-sender-avatar')).toHaveCount(1);
  await expect(different.locator('.message-sender-avatar')).toHaveCount(1);
  await expect(runStart.locator('.message-sender-role.owner')).toHaveText('owner');
  await expect(first.locator('.message-author')).toHaveCount(0);
  await expect(last.locator('.message-author')).toHaveCount(0);
  await expect(different.locator('.message-sender-role.admin')).toHaveText('moderator');
  const roleAlignment = await runStart.evaluate((message) => {
    const role = message.querySelector('.message-sender-role')?.getBoundingClientRect();
    const name = message.querySelector('.message-author > span')?.getBoundingClientRect();
    const bubble = message.getBoundingClientRect();
    if (!role || !name) throw new Error('Message author header is missing');
    return {
      roleRightInset: bubble.right - role.right,
      roleStartsAfterName: role.left > name.right,
    };
  });
  expect(roleAlignment.roleRightInset).toBeLessThan(12);
  expect(roleAlignment.roleStartsAfterName).toBe(true);
  const authorColors = await Promise.all(
    [runStart, different].map((message) =>
      message.locator('.message-author').evaluate((element) => getComputedStyle(element).color),
    ),
  );
  expect(authorColors[0]).not.toBe(authorColors[1]);
  const gaps = await page.evaluate(() => {
    const boxes = [6, 7, 8].map((id) =>
      document.querySelector(`[data-message-id="${id}"]`)?.getBoundingClientRect(),
    );
    if (boxes.some((box) => !box)) throw new Error('Expected channel messages are missing');
    return {
      sameAuthor: boxes[1]!.top - boxes[0]!.bottom,
      differentAuthor: boxes[2]!.top - boxes[1]!.bottom,
    };
  });
  expect(gaps.sameAuthor).toBeGreaterThanOrEqual(3);
  expect(gaps.differentAuthor).toBeGreaterThan(gaps.sameAuthor);
});

test('starts and restarts bots, sends commands, and handles bot keyboards', async ({ page }) => {
  await openReady(page);
  await page.getByRole('textbox', { name: 'Search chats' }).fill('helper');
  await page.getByTestId('peer-search-result').filter({ hasText: 'Fixture Helper Bot' }).click();

  await page.getByRole('button', { name: 'Start bot' }).click();
  await expect(page.getByTestId('message-scroller')).toContainText('/start');
  await expect(page.getByTestId('reply-bot-keyboard')).toBeVisible();
  await expect(page.getByTestId('inline-bot-keyboard')).toBeVisible();

  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /\/help.*Show available commands/ }).click();
  await expect(page.getByTestId('message-scroller')).toContainText('/help');

  await page.getByTestId('reply-bot-keyboard').getByRole('button', { name: 'Status' }).click();
  await expect(page.getByTestId('message-scroller')).toContainText('Status');

  await page.getByTestId('inline-bot-keyboard').getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('.bot-callback-notice')).toContainText('Fixture callback complete.');

  await page.getByRole('button', { name: 'Menu', exact: true }).click();
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
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
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
    window.__televechaFixture?.setBotCommands('g:303', [
      {
        command: 'status',
        description: 'Show group status',
        botId: 'u:606',
        botUsername: 'fixture_helper_bot',
        botName: 'Fixture Helper Bot',
      },
    ]);
  });
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Fixture Group/ })
    .click();

  await page.getByRole('button', { name: 'Menu', exact: true }).click();
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
    window.__televechaFixture?.holdNextBotCallback();
  });

  await page.getByTestId('inline-bot-keyboard').getByRole('button', { name: 'Refresh' }).click();
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Alice Fixture/ })
    .click();
  await page.evaluate(() => window.__televechaFixture?.releaseBotCallback());
  await expect(page.locator('.bot-callback-notice')).toHaveCount(0);
});

test('asks for explicit consent before opening a URL-auth button', async ({ page }) => {
  await openReady(page);
  await page.evaluate(() => {
    window.__televechaFixture?.useExtendedUrlAuth();
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
  expect(await page.evaluate(() => window.__televechaFixture?.acceptedUrlAuthOptions)).toEqual({
    writeAllowed: true,
    matchCode: 'L9M4',
  });
});

test('repeats message commands without replacing the draft and keeps bot controls in the composer', async ({
  page,
}) => {
  await openReady(page);
  await page.getByRole('textbox', { name: 'Search chats' }).fill('helper');
  await page.getByTestId('peer-search-result').filter({ hasText: 'Fixture Helper Bot' }).click();
  await page.getByRole('button', { name: 'Start bot' }).click();
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Keep my unfinished message');
  const count = (await fixtureStats(page))?.sendText ?? 0;
  await page
    .getByTestId('message-scroller')
    .getByRole('button', { name: '/start', exact: true })
    .click();
  await expect.poll(async () => (await fixtureStats(page))?.sendText).toBe(count + 1);
  await expect(input).toHaveValue('Keep my unfinished message');
  await expect(
    page.locator('.chat-composer').getByRole('button', { name: 'Menu', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Hide bot keyboard' }).click();
  await expect(page.getByTestId('reply-bot-keyboard')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show bot keyboard' }).click();
  await expect(page.getByTestId('reply-bot-keyboard')).toBeVisible();
  await input.fill('/he');
  await expect(page.getByRole('menuitem', { name: /\/help/ })).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect.poll(async () => (await fixtureStats(page))?.sendText).toBe(count + 2);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.screenshot({ path: '/tmp/televecha-bot-desktop.png' });
  await input.click();
  await expect(page.getByRole('menu', { name: 'Bot commands' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.chat-sidebar')).toBeHidden();
  await page.screenshot({ path: '/tmp/televecha-bot-mobile.png', animations: 'disabled' });
  expect(
    await page.locator('.chat-composer').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
});

test('renders live rich drafts in place and clears them on final delivery or expiry', async ({
  page,
}) => {
  await openReady(page);
  await page.getByRole('textbox', { name: 'Search chats' }).fill('helper');
  await page.getByTestId('peer-search-result').filter({ hasText: 'Fixture Helper Bot' }).click();
  await page.getByRole('button', { name: 'Start bot' }).click();
  await expect(page.getByTestId('inline-bot-keyboard')).toBeVisible();
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'live-draft',
      draft: { id: 'u:606:0:1', peerId: 'u:606', text: '' },
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => [...(window.__televechaRuntimes?.values() ?? [])][0]?.engine.snapshot().liveDrafts,
      ),
    )
    .toMatchObject([{ id: 'u:606:0:1' }]);
  const draft = page.getByTestId('bot-live-draft');
  await expect(draft).toContainText('Thinking…');
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'live-draft',
      draft: {
        id: 'u:606:0:1',
        peerId: 'u:606',
        text: '',
        richMessage: {
          blocks: [
            { kind: 'heading', level: 2, text: { kind: 'text', text: 'Streaming answer' } },
            { kind: 'math', source: String.raw`x^2 + \frac{1}{2}` },
          ],
        },
      },
    }),
  );
  await expect(draft).toHaveCount(1);
  await expect(draft.getByRole('heading', { name: 'Streaming answer' })).toBeVisible();
  await expect(draft.locator('.katex')).toBeVisible();
  await page.screenshot({ path: '/tmp/televecha-bot-stream.png' });
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 13,
      ptsCount: 1,
      message: {
        id: 900,
        peerId: 'u:606',
        senderId: 'u:606',
        text: 'Final answer',
        date: Math.floor(Date.now() / 1000),
        outgoing: false,
      },
    }),
  );
  await expect(draft).toHaveCount(0);
  await page.clock.install();
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'live-draft',
      draft: { id: 'u:606:0:2', peerId: 'u:606', text: 'Partial answer' },
    }),
  );
  await expect(draft).toContainText('Partial answer');
  await page.clock.fastForward(31_000);
  await expect(draft).toHaveCount(0);
});

test('recognizes CamelCase and addressed bot commands but leaves code and links alone', async ({
  page,
}) => {
  await openReady(page);
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Fixture Group/ })
    .click();
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 91,
        peerId: 'g:303',
        senderId: 'u:606',
        text: '/usersCount@fixture_helper_bot /code https://example.com/menu',
        date: Math.floor(Date.now() / 1000),
        outgoing: false,
        formats: [
          { kind: 'botCommand', offset: 0, length: '/usersCount@fixture_helper_bot'.length },
          { kind: 'code', offset: '/usersCount@fixture_helper_bot '.length, length: 5 },
        ],
      },
    }),
  );
  const message = page.locator('article[data-message-id="91"]');
  await expect(message.locator('.message-bot-command')).toHaveCount(1);
  await expect(message.locator('.code')).toHaveText('/code');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Unfinished group message');
  await message
    .getByRole('button', { name: '/usersCount@fixture_helper_bot', exact: true })
    .click();
  await expect.poll(async () => (await fixtureStats(page))?.sendText).toBe(1);
  await expect(input).toHaveValue('Unfinished group message');
  await expect(page.locator('.message.outgoing .message-body')).toContainText(
    '/usersCount@fixture_helper_bot',
  );
});

test('keeps callback alerts visible until dismissed', async ({ page }) => {
  await openReady(page);
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Fixture Group/ })
    .click();
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 92,
        peerId: 'g:303',
        senderId: 'u:606',
        text: 'Show an alert',
        date: Math.floor(Date.now() / 1000),
        outgoing: false,
        botKeyboard: {
          kind: 'inline',
          rows: [[{ kind: 'callback', text: 'Show alert', data: [99] }]],
        },
      },
    }),
  );
  await page.getByRole('button', { name: 'Show alert', exact: true }).click();
  const alert = page.getByRole('dialog', { name: 'Bot message' });
  await expect(alert).toContainText('Fixture callback complete.');
  await expect(page.locator('.bot-callback-notice')).toHaveCount(0);
  await alert.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(alert).toHaveCount(0);
});
