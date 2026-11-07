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
