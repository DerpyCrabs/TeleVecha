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
    expect(await page.evaluate(() => window.__televechaFixture!.stats.readMessageContents)).toEqual(
      [],
    );
    if (kind === 'voice') await second.getByRole('button', { name: 'Play voice message' }).click();
    const player = second.locator(
      kind === 'voice' ? 'audio[data-voice-audio]' : 'article[data-message-id="81"] video',
    );
    await expect(player).toBeAttached();
    if (kind !== 'voice') await expect(player).toBeVisible();
    await expect
      .poll(() => player.evaluate((element: HTMLMediaElement) => element.readyState))
      .toBeGreaterThanOrEqual(2);

    await player.evaluate(async (element: HTMLMediaElement) => {
      element.muted = true;
      await element.play();
    });
    await expect.poll(() => unread(second)).toBe(false);
    await expect.poll(() => unread(page)).toBe(false);
    if (kind === 'voice') await page.getByRole('button', { name: 'Play voice message' }).click();
    const ownerPlayer = page.locator(
      kind === 'voice' ? 'audio[data-voice-audio]' : 'article[data-message-id="81"] video',
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

    test('plays, seeks, and changes speed in compact voice messages', async ({ page }) => {
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
                waveform: Array.from(
                  { length: 100 },
                  (_, i) => 3 + Math.round(Math.abs(Math.sin(i * 0.8) * Math.cos(i * 0.17)) * 28),
                ),
              },
            },
          });
        }
      });

      await page.evaluate(() =>
        window.__televechaFixture!.emit({
          type: 'new-message',
          pts: 13,
          ptsCount: 1,
          message: {
            id: 83,
            peerId: 'u:101',
            senderId: 'self',
            text: 'On my way',
            date: Math.floor(Date.now() / 1000) + 2,
            outgoing: true,
            replyToId: 81,
          },
        }),
      );
      const reply = page.locator('article[data-message-id="83"] .message-reply');
      await expect(reply).toContainText('Alice Fixture');
      await expect(reply).toContainText('Voice message · 0:58');
      await expect(reply).not.toContainText('.ogg');
      await expect(reply.locator('audio, video, button, input')).toHaveCount(0);
      await reply.click();
      await expect(page.locator('article[data-message-id="81"]')).toBeInViewport();

      expect(
        await page.evaluate(() => window.__televechaFixture?.stats.readMessageContents),
      ).toEqual([]);
      for (const id of [81, 82]) {
        const message = page.locator(`article[data-message-id="${id}"]`);
        const audio = page.locator('audio[data-voice-audio]');
        const player = message.locator('.voice-player');
        await player.scrollIntoViewIfNeeded();
        await expect(player).toBeVisible();

        const bounds = await player.evaluate((element) => {
          const audio = element.getBoundingClientRect();
          const bubble = element.closest('article')!.getBoundingClientRect();
          return {
            width: audio.width,
            height: audio.height,
            contained: audio.left >= bubble.left && audio.right <= bubble.right,
          };
        });
        expect(bounds.width).toBeGreaterThanOrEqual(280);
        expect(bounds.height).toBeLessThanOrEqual(70);
        expect(bounds.contained).toBe(true);
        await message.getByRole('button', { name: 'Play voice message' }).click();
        await expect
          .poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused))
          .toBe(true);
        await expect
          .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
          .toBeGreaterThan(0);
        await expect
          .poll(() => page.evaluate(() => window.__televechaFixture?.stats.readMessageContents))
          .toEqual([{ peerId: 'u:101', messageIds: [81] }]);
        await message.getByRole('button', { name: 'Pause voice message' }).click();
        await expect
          .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
          .toBe(true);
        await message.getByRole('slider', { name: 'Seek voice message' }).fill('29');
        await expect
          .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
          .toBeCloseTo(29, 0);
        await expect(message.getByRole('button', { name: /speed/i })).toHaveCount(0);
        await page
          .getByRole('region', { name: 'Voice memo player' })
          .getByRole('button', { name: `Voice memo speed ${id === 81 ? 1 : 1.5}x`, exact: true })
          .click();
        await expect
          .poll(() => audio.evaluate((element: HTMLAudioElement) => element.playbackRate))
          .toBe(id === 81 ? 1.5 : 2);
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
      await page.locator('article[data-message-id="83"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath('voice-replies.png') });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
    });
  });
}

test('keeps playing across chats and advances only to later unheard incoming memos', async ({
  page,
}) => {
  await openReady(page, '/?chat=u%3A101');
  await page.evaluate(() => {
    for (const [index, id] of [81, 82, 83, 84, 85].entries()) {
      const message = {
        id,
        peerId: 'u:101',
        senderId: 'u:101',
        text: '',
        date: Math.floor(Date.now() / 1000) + index,
        outgoing: id === 83,
        mediaUnread: id !== 82,
        media: {
          kind: 'voice' as const,
          name: `voice-${id}.ogg`,
          mimeType: 'audio/ogg',
          duration: 58,
        },
      };
      window.__televechaFixture!.setMessages([message]);
      // The last memo exists on the server but has never been rendered.
      if (id !== 85)
        window.__televechaFixture!.emit({
          type: 'new-message',
          pts: 11 + index,
          ptsCount: 1,
          message,
        });
    }
  });
  const bubble = (id: number) => page.locator(`article[data-message-id="${id}"]`);
  await expect(bubble(81).getByRole('button', { name: 'Play voice message' })).toBeVisible();
  await expect(page.locator('audio[data-voice-audio]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Voice memo player' })).toBeHidden();
  await bubble(81).getByRole('button', { name: 'Play voice message' }).click();
  const audio = page.locator('audio[data-voice-audio]');
  const player = page.getByRole('region', { name: 'Voice memo player' });
  await expect(player).toContainText('Alice Fixture');
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true);
  await player.getByRole('button', { name: 'Voice memo speed 1x', exact: true }).click();
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Fixture Group/ })
    .click();
  await expect(bubble(81)).toHaveCount(0);
  await expect(player).toBeVisible();
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true);
  await player.getByRole('button', { name: 'Pause voice memo' }).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  await player.getByRole('button', { name: 'Resume voice memo' }).click();
  await audio.evaluate((element: HTMLAudioElement) => {
    element.currentTime = element.duration - 0.1;
  });
  await expect
    .poll(() => page.evaluate(() => window.__televechaFixture!.stats.readMessageContents))
    .toEqual([
      { peerId: 'u:101', messageIds: [81] },
      { peerId: 'u:101', messageIds: [84] },
    ]);
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.playbackRate))
    .toBe(1.5);
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Alice Fixture/ })
    .click();
  await expect(bubble(84).getByRole('button', { name: 'Pause voice message' })).toBeVisible();
  await expect(bubble(81).getByRole('button', { name: 'Play voice message' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('global-voice-player.png') });
  await audio.evaluate((element: HTMLAudioElement) => {
    element.currentTime = element.duration - 0.1;
  });
  await expect
    .poll(() => page.evaluate(() => window.__televechaFixture!.stats.readMessageContents))
    .toEqual([
      { peerId: 'u:101', messageIds: [81] },
      { peerId: 'u:101', messageIds: [84] },
      { peerId: 'u:101', messageIds: [85] },
    ]);
  await player.getByRole('button', { name: 'Close voice memo player' }).click();
  await expect(player).toBeHidden();
  await expect
    .poll(() =>
      audio.evaluate((element: HTMLAudioElement) => element.paused && !element.getAttribute('src')),
    )
    .toBe(true);
  await expect(bubble(84).getByRole('button', { name: 'Play voice message' })).toBeVisible();

  await bubble(85).getByRole('button', { name: 'Play voice message' }).click();
  await expect(player.getByRole('button', { name: 'Pause voice memo' })).toBeVisible();
  await audio.evaluate((element: HTMLAudioElement) => {
    element.currentTime = element.duration - 0.1;
  });
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.ended)).toBe(true);
  await expect(player).toBeVisible();
  await expect(player).not.toHaveClass(/is-closing/);
  await expect(player).toHaveClass(/is-closing/, { timeout: 6_000 });
  await expect
    .poll(() => player.evaluate((element) => getComputedStyle(element).transform))
    .not.toBe('none');
  await expect(player).toBeHidden();
});

test('restores listened appearance after reload and aligns duration with message time', async ({
  page,
}) => {
  await page.goto('/?scenario=held-connect&chat=u%3A101');
  await expect
    .poll(() => page.evaluate(() => window.__televechaFixture?.stats.connect ?? 0))
    .toBeGreaterThan(0);
  await page.evaluate(() => window.__televechaFixture!.releaseConnect());
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__televechaRuntimes?.get('fixture:held-connect')?.engine.snapshot().online,
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    for (const id of [81, 82])
      window.__televechaFixture!.emit({
        type: 'new-message',
        pts: id - 70,
        ptsCount: 1,
        message: {
          id,
          peerId: 'u:101',
          senderId: 'u:101',
          text: '',
          date: Math.floor(Date.now() / 1000) + id,
          outgoing: false,
          mediaUnread: true,
          media: { kind: 'voice', name: `voice-${id}.ogg`, mimeType: 'audio/ogg', duration: 58 },
        },
      });
  });
  const memo = (id: number) => page.locator(`article[data-message-id="${id}"]`);
  await expect(memo(81).getByLabel('Unheard voice message')).toBeVisible();
  await memo(81).getByRole('button', { name: 'Play voice message' }).click();
  await expect(memo(81).getByLabel('Unheard voice message')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close voice memo player' }).click();
  await page.reload();
  await expect(memo(81).locator('.voice-player')).toBeVisible();
  await expect(memo(81).getByLabel('Unheard voice message')).toHaveCount(0);
  await expect(memo(82).getByLabel('Unheard voice message')).toBeVisible();
  await expect(memo(81).locator('.voice-waveform-played')).toHaveCSS(
    'clip-path',
    'inset(0px 0% 0px 0px)',
  );
  await expect(memo(82).locator('.voice-waveform-played')).toHaveCSS(
    'clip-path',
    'inset(0px 100% 0px 0px)',
  );
  const layout = await memo(81).evaluate((element) => {
    const bubble = element.getBoundingClientRect();
    const button = element.querySelector('.voice-play')!.getBoundingClientRect();
    const waveform = element.querySelector('.voice-seek svg')!.getBoundingClientRect();
    const duration = element.querySelector('.voice-duration')!.getBoundingClientRect();
    const time = element.querySelector('footer')!.getBoundingClientRect();
    return {
      waveformHeight: waveform.height,
      buttonAlignment: Math.abs(
        (button.top + button.bottom) / 2 - (bubble.top + bubble.bottom) / 2,
      ),
      waveformTimeGap: duration.top - waveform.bottom,
      bottomInset: bubble.bottom - time.bottom,
      waveformAboveButton: (button.top + button.bottom) / 2 - (waveform.top + waveform.bottom) / 2,
      alignment: Math.abs((duration.top + duration.bottom) / 2 - (time.top + time.bottom) / 2),
      height: element.getBoundingClientRect().height,
    };
  });
  expect(layout.waveformHeight).toBe(32);
  expect(layout.buttonAlignment).toBeLessThan(1);
  expect(layout.waveformTimeGap).toBeGreaterThanOrEqual(0);
  expect(layout.bottomInset).toBeLessThan(7);
  expect(layout.waveformAboveButton).toBeGreaterThan(0);
  expect(layout.alignment).toBeLessThan(3);
  expect(layout.height).toBeLessThan(100);
  await page.screenshot({ path: test.info().outputPath('voice-listened-reload.png') });
});

test('restores watched round video ring after reload', async ({ page }) => {
  await page.goto('/?scenario=held-connect&chat=u%3A101');
  await expect
    .poll(() => page.evaluate(() => window.__televechaFixture?.stats.connect ?? 0))
    .toBeGreaterThan(0);
  await page.evaluate(() => window.__televechaFixture!.releaseConnect());
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__televechaRuntimes?.get('fixture:held-connect')?.engine.snapshot().online,
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    for (const id of [81, 82])
      window.__televechaFixture!.emit({
        type: 'new-message',
        pts: id - 70,
        ptsCount: 1,
        message: {
          id,
          peerId: 'u:101',
          senderId: 'u:101',
          text: '',
          date: Math.floor(Date.now() / 1000) + id,
          outgoing: false,
          mediaUnread: true,
          media: {
            kind: 'round-video',
            name: `round-${id}.mp4`,
            mimeType: 'video/mp4',
            duration: 8,
            width: 240,
            height: 240,
          },
        },
      });
  });
  const memo = (id: number) => page.locator(`article[data-message-id="${id}"]`);
  const ring = (id: number) => memo(id).locator('.round-video-progress circle').last();
  await expect(memo(81).getByLabel('Unwatched video message', { exact: true })).toBeVisible();
  await expect(ring(81)).toHaveAttribute('stroke-dashoffset', '100');
  await memo(81).getByRole('button', { name: 'Play video message', exact: true }).click();
  await expect(memo(81).getByLabel('Watched video message', { exact: true })).toBeVisible();
  await page.reload();
  await expect(memo(81).locator('.round-video-player')).toBeVisible();
  await expect(memo(81).getByLabel('Watched video message', { exact: true })).toBeVisible();
  await expect(ring(81)).toHaveAttribute('stroke-dashoffset', '0');
  const alignment = await memo(81).evaluate((message) => {
    const videoBottom = message
      .querySelector('.media-round-video-visual')!
      .getBoundingClientRect().bottom;
    const footer = message.querySelector('footer')!;
    const pillBottom = footer.getBoundingClientRect().bottom;
    return {
      timestampGap: Math.abs(pillBottom - videoBottom),
      extraHeight:
        message.getBoundingClientRect().bottom -
        message.querySelector('.media-round-video-visual')!.getBoundingClientRect().bottom,
    };
  });
  expect(alignment.timestampGap).toBeLessThan(0.5);
  expect(alignment.extraHeight).toBeLessThan(0.5);

  await expect(memo(82).getByLabel('Unwatched video message', { exact: true })).toBeVisible();
  await expect(ring(82)).toHaveAttribute('stroke-dashoffset', '100');
  const toggle = memo(82).locator('.round-video-toggle');
  const icon = memo(82).locator('.round-video-play-icon');
  await toggle.hover();
  await expect(icon).toHaveCSS('opacity', '1');
  await toggle.click();
  await page.mouse.move(0, 0);
  await expect(icon).toHaveCSS('opacity', '0');
  await toggle.hover();
  await expect(icon).toHaveCSS('opacity', '1');
});
