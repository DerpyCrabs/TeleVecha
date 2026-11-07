import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';

for (const width of [1280, 375]) {
  test(`acknowledges replies only when the chat is visible with search at ${width}px`, async ({
    page,
  }) => {
    await openReady(page, '/?chat=u%3A101');
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole('button', { name: 'Search messages', exact: true }).click();
    await page.evaluate(() =>
      window.__televechaFixture!.emit({
        type: 'new-message',
        pts: 11,
        ptsCount: 1,
        message: {
          id: 81,
          peerId: 'u:101',
          senderId: 'u:101',
          text: 'Unread reply with search open',
          date: Math.floor(Date.now() / 1000),
          outgoing: false,
          replyToId: 80,
          unreadMention: true,
          mediaUnread: true,
        },
      }),
    );
    const unread = () =>
      page.evaluate(
        () =>
          [...window.__televechaRuntimes!.values()][0]!.engine
            .snapshot()
            .messages.find((message) => message.id === 81)?.unreadMention,
      );
    if (width <= 650) {
      await expect(page.locator('.search-panel')).toHaveAttribute('role', 'dialog');
      await expect.poll(unread).toBe(true);
      expect(
        await page.evaluate(() => window.__televechaFixture!.stats.readMessageContents),
      ).toEqual([]);
      await page.getByRole('button', { name: 'Close search' }).click();
    }
    await expect.poll(unread).toBe(false);
    await expect
      .poll(() => page.evaluate(() => window.__televechaFixture!.stats.readMessageContents))
      .toEqual([{ peerId: 'u:101', messageIds: [81] }]);
  });
}

for (const kind of ['mention', 'reaction'] as const) {
  test(`jumps to an older unread ${kind} and acknowledges it only after showing it`, async ({
    page,
  }) => {
    await openReady(page, '/?chat=u%3A101');
    await page.evaluate((kind) => {
      const runtime = [...window.__televechaRuntimes!.values()][0]!;
      const dialog = runtime.engine
        .snapshot()
        .dialogs.find((dialog) => dialog.peer.id === 'u:101')!;
      const message = {
        id: 5,
        peerId: dialog.peer.id,
        peer: dialog.peer,
        senderId: kind === 'reaction' ? 'self' : 'u:101',
        text: 'Older unread notification target',
        date: 1_700_000_005,
        outgoing: kind === 'reaction',
        unreadMention: kind === 'mention',
        mediaUnread: kind === 'mention',
        unreadReaction: kind === 'reaction',
        ...(kind === 'reaction'
          ? { reactions: [{ emoji: '👍', count: 1, chosen: false }] }
          : { replyToId: 4 }),
      };
      window.__televechaFixture!.setMessages([message]);
      window.__televechaFixture!.emit({
        type: 'dialog-changed',
        dialog: {
          ...dialog,
          [kind === 'mention' ? 'unreadMentionsCount' : 'unreadReactionsCount']: 1,
        },
      });
    }, kind);
    const button = page.getByRole('button', {
      name:
        kind === 'mention'
          ? 'Unread replies and mentions: 1. Go to message'
          : 'Unread reactions: 1. Go to message',
    });
    await expect(button).toBeVisible();
    expect(await page.evaluate(() => window.__televechaFixture!.stats.readMessageContents)).toEqual(
      [],
    );
    await button.click();
    await expect(page.locator('article[data-message-id="5"]')).toBeInViewport();
    await expect
      .poll(() => page.evaluate(() => window.__televechaFixture!.stats.readMessageContents))
      .toEqual([{ peerId: 'u:101', messageIds: [5] }]);
    await expect(button).toHaveCount(0);
  });
}

for (const width of [1280, 375]) {
  test(`reconciles a stale loaded reaction and shows reactions beneath tall messages at ${width}px`, async ({
    page,
  }) => {
    await openReady(page, '/?chat=u%3A101');
    await page.setViewportSize({ width, height: 800 });
    await expect(
      page.getByTestId('message-scroller').getByText('Newest message from fixture'),
    ).toBeVisible();
    await page.evaluate(() => {
      const runtime = [...window.__televechaRuntimes!.values()][0]!;
      const snapshot = runtime.engine.snapshot();
      const dialog = snapshot.dialogs.find((dialog) => dialog.peer.id === 'u:101')!;
      const source = snapshot.messages.find((message) => message.id === 40)!;
      window.__televechaFixture!.setMessages([
        {
          ...source,
          text: Array(90).fill('A tall notification target').join('\n'),
          unreadReaction: true,
          reactions: [{ emoji: '👍', count: 1, chosen: false }],
        },
      ]);
      window.__televechaFixture!.emit({
        type: 'dialog-changed',
        dialog: { ...dialog, unreadReactionsCount: 1 },
      });
    });
    await page.getByRole('button', { name: 'Unread reactions: 1. Go to message' }).click();
    await expect(page.locator('article[data-message-id="40"] .reaction')).toBeInViewport();
    await expect
      .poll(() => page.evaluate(() => window.__televechaFixture!.stats.readMessageContents))
      .toEqual([{ peerId: 'u:101', messageIds: [40] }]);
    await expect(page.getByRole('button', { name: /Unread reactions:/ })).toHaveCount(0);
  });

  test(`marks all remote notifications read without jumping at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openReady(page, '/?chat=u%3A101');
    await page.setViewportSize({ width, height: 800 });
    await expect(
      page.getByTestId('message-scroller').getByText('Newest message from fixture'),
    ).toBeVisible();
    await page.evaluate(() => {
      const snapshot = [...window.__televechaRuntimes!.values()][0]!.engine.snapshot();
      const dialog = snapshot.dialogs.find((dialog) => dialog.peer.id === 'u:101')!;
      window.__televechaFixture!.setMessages(
        Array.from({ length: 150 }, (_, index) => ({
          id: 1000 + index,
          peerId: dialog.peer.id,
          senderId: 'self',
          text: 'Remote unread notification',
          date: 1_700_001_000 + index,
          outgoing: true,
          unreadReaction: true,
          unreadMention: true,
          mediaUnread: true,
          reactions: [{ emoji: '👍', count: 1, chosen: false }],
        })),
      );
      window.__televechaFixture!.emit({
        type: 'dialog-changed',
        dialog: { ...dialog, unreadReactionsCount: 150, unreadMentionsCount: 150 },
      });
    });
    if (width > 650)
      await page
        .getByRole('button', { name: 'Unread reactions: 150. Go to message' })
        .click({ button: 'right' });
    else await page.getByRole('button', { name: 'Notification options', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Mark all as read' })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`notifications-${width}.png`),
      animations: 'disabled',
    });
    await page.getByRole('menuitem', { name: 'Mark all as read' }).click();
    await expect
      .poll(() => page.evaluate(() => window.__televechaFixture!.stats.readAllNotifications))
      .toEqual([
        { peerId: 'u:101', kind: 'mention' },
        { peerId: 'u:101', kind: 'reaction' },
      ]);
    await expect(page.locator('.unread-notifications button')).toHaveCount(0);
    expect(await page.evaluate(() => window.__televechaFixture!.stats.readMessageContents)).toEqual(
      [],
    );
    await expect(page.locator('article[data-message-id="80"]')).toBeInViewport();
  });
}
