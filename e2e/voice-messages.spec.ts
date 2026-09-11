import { expect, test } from '@playwright/test';
import { openReady } from './helpers';

for (const kind of ['voice', 'round-video'] as const) {
  test(`synchronizes ${kind} playback from a follower tab without duplicate receipts`, async ({
    context,
    page,
  }) => {
    await openReady(page, '/?chat=u%3A101');
    const second = await context.newPage();
    await openReady(second, '/?chat=u%3A101');
    await page.evaluate((kind) => {
      window.__televechaFixture!.emit({
        type: 'new-message',
        pts: 11,
        ptsCount: 1,
        message: {
          id: 81,
          peerId: 'u:101',
          senderId: 'u:101',
          text: '',
          date: Math.floor(Date.now() / 1000),
          outgoing: false,
          mediaUnread: true,
          media: {
            kind,
            name: kind === 'voice' ? 'voice.ogg' : 'round.mp4',
            mimeType: kind === 'voice' ? 'audio/ogg' : 'video/mp4',
            duration: 8,
            ...(kind === 'round-video' ? { width: 240, height: 240 } : {}),
          },
        },
      });
    }, kind);
    const unread = (target: typeof page) =>
      target.evaluate(
        () =>
          window
            .__televechaRuntimes!.get('fixture:default')!
            .engine.snapshot()
            .messages.find(({ id }) => id === 81)?.mediaUnread,
      );
    await expect.poll(() => unread(second)).toBe(true);
    const player = second.locator(
      'article[data-message-id="81"] audio, article[data-message-id="81"] video',
    );
    await expect(player).toBeVisible();
    await expect
      .poll(() => player.evaluate((element: HTMLMediaElement) => element.readyState))
      .toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => window.__televechaFixture!.stats.readMessageContents)).toEqual(
      [],
    );
    await player.evaluate(async (element: HTMLMediaElement) => {
      element.muted = true;
      await element.play();
    });
    await expect.poll(() => unread(second)).toBe(false);
    await expect.poll(() => unread(page)).toBe(false);
    const ownerPlayer = page.locator(
      'article[data-message-id="81"] audio, article[data-message-id="81"] video',
    );
    await ownerPlayer.evaluate(async (element: HTMLMediaElement) => {
      element.muted = true;
      await element.play();
    });
    // Drain a subsequent command from each tab after its playing event.
    for (const target of [page, second])
      await target.evaluate(async () => {
        const runtime = window.__televechaRuntimes!.get('fixture:default')!;
        await runtime.runEffect(runtime.engine.markMediaRead({ id: 'u:101', kind: 'user' }, 81));
      });
    expect(await page.evaluate(() => window.__televechaFixture!.stats.readMessageContents)).toEqual(
      [{ peerId: 'u:101', messageIds: [81] }],
    );
  });
}

for (const device of [
  {
    name: 'desktop',
    viewport: { width: 2371, height: 643 },
    deviceScaleFactor: 1.6,
    isMobile: false,
  },
  { name: 'phone', viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true },
]) {
  test.describe(device.name, () => {
    test.use({
      viewport: device.viewport,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.isMobile,
    });

    test('keeps captionless voice controls wide enough to play and pause', async ({ page }) => {
      await page.goto('/');
      if (device.isMobile) await page.getByRole('button', { name: 'Open chat list' }).click();
      await page
        .getByTestId('chat-list')
        .getByRole('button', { name: /Alice Fixture/ })
        .click();
      await expect(page.getByText('Newest message from fixture')).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => [...(window.__televechaRuntimes?.values() ?? [])][0]?.engine.snapshot().online,
          ),
        )
        .toBe(true);
      await page.evaluate(() => {
        for (const [index, outgoing] of [false, true].entries()) {
          window.__televechaFixture?.emit({
            type: 'new-message',
            pts: 11 + index,
            ptsCount: 1,
            message: {
              id: 81 + index,
              peerId: 'u:101',
              senderId: outgoing ? 'self' : 'u:101',
              text: '',
              date: Math.floor(Date.now() / 1000) + index,
              outgoing,
              mediaUnread: true,
              media: {
                kind: 'voice',
                name: `voice-${index}.ogg`,
                mimeType: 'audio/ogg',
                duration: 58,
              },
            },
          });
        }
      });

      expect(
        await page.evaluate(() => window.__televechaFixture?.stats.readMessageContents),
      ).toEqual([]);
      for (const id of [81, 82]) {
        const message = page.locator(`article[data-message-id="${id}"]`);
        const audio = message.locator('audio[controls]');
        await audio.scrollIntoViewIfNeeded();
        await expect(audio).toBeVisible();
        const bounds = await audio.evaluate((element) => {
          const audio = element.getBoundingClientRect();
          const bubble = element.closest('article')!.getBoundingClientRect();
          return {
            width: audio.width,
            height: audio.height,
            contained: audio.left >= bubble.left && audio.right <= bubble.right,
          };
        });
        expect(bounds.width).toBeGreaterThanOrEqual(280);
        expect(bounds.width / bounds.height).toBeGreaterThan(5);
        expect(bounds.contained).toBe(true);
        await expect
          .poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState))
          .toBeGreaterThanOrEqual(2);
        await expect
          .poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration))
          .toBe(58);
        if (id === 81)
          expect(
            await page.evaluate(() => window.__televechaFixture?.stats.readMessageContents),
          ).toEqual([]);
        await audio.evaluate((element: HTMLAudioElement) => {
          element.muted = true;
        });
        await audio.click({ position: { x: 25, y: bounds.height / 2 } });
        await expect
          .poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused))
          .toBe(true);
        await expect
          .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
          .toBeGreaterThan(0);
        await expect
          .poll(() => page.evaluate(() => window.__televechaFixture?.stats.readMessageContents))
          .toEqual([{ peerId: 'u:101', messageIds: [81] }]);
        await audio.click({ position: { x: 25, y: bounds.height / 2 } });
        await expect
          .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
          .toBe(true);
        await audio.evaluate(async (element: HTMLAudioElement) => {
          await element.play();
          element.pause();
        });
        // Resuming the incoming note and playing our own outgoing note cannot
        // acknowledge it again or pretend its recipient listened to it.
        expect(
          await page.evaluate(() => window.__televechaFixture?.stats.readMessageContents),
        ).toEqual([{ peerId: 'u:101', messageIds: [81] }]);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
    });
  });
}
