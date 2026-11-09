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

for (const width of [1280, 375]) {
  for (const loaded of [false, true]) {
    for (const kind of ['mention', 'reaction'] as const) {
      test(`keeps ${loaded ? 'loaded' : 'fetched'} unread ${kind} visible after acknowledgement and new messages at ${width}px`, async ({
        page,
      }) => {
        await openReady(page, '/?chat=u%3A101');
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(
          ({ kind, loaded }) => {
            const runtime = [...window.__televechaRuntimes!.values()][0]!;
            const dialog = runtime.engine
              .snapshot()
              .dialogs.find((dialog) => dialog.peer.id === 'u:101')!;
            const message = {
              id: loaded ? 40 : 5,
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
            if (loaded)
              window.__televechaFixture!.emit({
                type: 'edit-message',
                message,
                pts: 11,
                ptsCount: 1,
              });
            window.__televechaFixture!.emit({
              type: 'dialog-changed',
              dialog: {
                ...dialog,
                [kind === 'mention' ? 'unreadMentionsCount' : 'unreadReactionsCount']: 1,
              },
            });
          },
          { kind, loaded },
        );
        const button = page.getByRole('button', {
          name:
            kind === 'mention'
              ? 'Unread replies and mentions: 1. Go to message'
              : 'Unread reactions: 1. Go to message',
        });
        await expect(button).toBeVisible();
        expect(
          await page.evaluate(() => window.__televechaFixture!.stats.readMessageContents),
        ).toEqual([]);
        await button.click();
        const targetId = loaded ? 40 : 5;
        const target = page.locator(
          `article[data-message-id="${targetId}"]${kind === 'reaction' ? ' .reaction' : ''}`,
        );
        await expect(target).toBeInViewport();
        await expect
          .poll(() => page.evaluate(() => window.__televechaFixture!.stats.readMessageContents))
          .toEqual([{ peerId: 'u:101', messageIds: [targetId] }]);
        await expect(button).toHaveCount(0);
        await expect(target).toBeInViewport();
        const position = await target.evaluate((element) => element.getBoundingClientRect().top);
        await page.evaluate(
          ({ targetId, loaded, kind }) => {
            const fixture = window.__televechaFixture!;
            const source = [...window.__televechaRuntimes!.values()][0]!.engine
              .snapshot()
              .messages.find(({ id }) => id === targetId)!;
            // The read acknowledgement is followed by a message edit and a new arrival.
            fixture.emit({
              type: 'edit-message',
              pts: loaded ? 12 : 11,
              ptsCount: 1,
              message: {
                ...source,
                text:
                  kind === 'reaction'
                    ? Array(30).fill('Edited reaction target').join('\n')
                    : 'Edited reply target',
              },
            });
            fixture.emit({
              type: 'new-message',
              pts: loaded ? 13 : 12,
              ptsCount: 1,
              message: {
                id: 181,
                peerId: 'u:101',
                senderId: 'u:101',
                text: Array(20).fill('New message after acknowledgement').join('\n'),
                date: 1_700_003_181,
                outgoing: false,
              },
            });
          },
          { targetId, loaded, kind },
        );
        await expect(page.locator('article[data-message-id="181"]')).toBeAttached();
        // Include highlight removal and subsequent render/scroll events, not just the first reveal.
        await expect(page.locator(`article[data-message-id="${targetId}"]`)).not.toHaveClass(
          /message-target/,
        );
        await expect(target).toBeInViewport();
        expect(
          Math.abs(
            (await target.evaluate((element) => element.getBoundingClientRect().top)) - position,
          ),
        ).toBeLessThan(3);
        await page.screenshot({ path: `/tmp/notification-${kind}-${loaded}-${width}.png` });
        await page.getByRole('button', { name: 'Jump to present', exact: true }).click();
        await expect
          .poll(() =>
            page
              .getByTestId('message-scroller')
              .evaluate(
                (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
              ),
          )
          .toBeLessThanOrEqual(2);
      });
    }
  }
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
    await expect(
      page.getByRole('button', { name: 'Notification options', exact: true }),
    ).toHaveCount(0);
    const reactionIndicator = page.getByRole('button', {
      name: 'Unread reactions: 150. Go to message',
    });
    await reactionIndicator.hover();
    expect(
      await reactionIndicator.evaluate((element) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        context.fillStyle = getComputedStyle(element).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data[3];
      }),
    ).toBe(255);
    if (width > 650)
      await page
        .getByRole('button', { name: 'Unread reactions: 150. Go to message' })
        .click({ button: 'right' });
    else {
      const indicator = page.getByRole('button', { name: 'Unread reactions: 150. Go to message' });
      await indicator.dispatchEvent('pointerdown', {
        pointerType: 'touch',
        clientX: 10,
        clientY: 10,
      });
      await expect(page.getByRole('menuitem', { name: 'Mark all as read' })).toBeVisible();
      await indicator.dispatchEvent('pointerup', { pointerType: 'touch' });
      await indicator.dispatchEvent('click');
    }
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

for (const width of [1280, 375]) {
  test(`visits two unread reactions in order and stays on the last one after the indicator disappears at ${width}px`, async ({
    page,
  }) => {
    await openReady(page, '/?chat=u%3A101');
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => {
      const snapshot = [...window.__televechaRuntimes!.values()][0]!.engine.snapshot();
      const dialog = snapshot.dialogs.find(({ peer }) => peer.id === 'u:101')!;
      window.__televechaFixture!.setMessages(
        [5, 40].map((id) => ({
          id,
          peerId: 'u:101',
          peer: dialog.peer,
          senderId: 'self',
          text: `Reaction target ${id}`,
          date: 1_700_000_000 + id,
          outgoing: true,
          unreadReaction: true,
          reactions: [{ emoji: '👍', count: 1, chosen: false }],
        })),
      );
      window.__televechaFixture!.emit({
        type: 'dialog-changed',
        dialog: { ...dialog, unreadReactionsCount: 2 },
      });
    });
    for (const [index, id] of [5, 40].entries()) {
      await page
        .getByRole('button', { name: `Unread reactions: ${2 - index}. Go to message` })
        .click();
      const target = page.locator(`article[data-message-id="${id}"] .reaction`);
      await expect(target).toBeInViewport();
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__televechaFixture!.stats.readMessageContents.flatMap(
              ({ messageIds }) => messageIds,
            ),
          ),
        )
        .toEqual([5, 40].slice(0, index + 1));
      await expect(page.locator(`article[data-message-id="${id}"]`)).not.toHaveClass(
        /message-target/,
      );
      await expect(target).toBeInViewport();
    }
    await expect(page.getByRole('button', { name: /Unread reactions:/ })).toHaveCount(0);
    await expect(page.locator('article[data-message-id="40"] .reaction')).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Jump to present', exact: true })).toBeVisible();
  });
}
