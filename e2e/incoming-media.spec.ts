import { test } from '@playwright/test';
import { expect } from './expect';

import type { TransportUpdate } from '../src/telegram/types';
import { openReady, selectAlice } from './helpers';

test('renders voice notes, circular video messages, service events, and albums', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);

  await page.evaluate(() => {
    const fixture = (
      window as typeof window & { __televechaFixture?: { emit(update: TransportUpdate): void } }
    ).__televechaFixture;
    if (!fixture) return;
    const peerId = 'u:101';
    const date = Math.floor(Date.now() / 1000);
    const messages = [
      {
        id: 81,
        text: '',
        media: {
          kind: 'voice' as const,
          name: 'fixture-voice.ogg',
          mimeType: 'audio/ogg',
          duration: 12,
        },
      },
      {
        id: 82,
        text: '',
        media: {
          kind: 'round-video' as const,
          name: 'fixture-video-message.mp4',
          mimeType: 'video/mp4',
          width: 240,
          height: 400,
          duration: 8,
        },
      },
      {
        id: 83,
        text: 'Three photos from Telegram',
        groupedId: 'fixture-album',
        media: {
          kind: 'photo' as const,
          name: 'album-one.jpg',
          mimeType: 'image/jpeg',
          width: 400,
          height: 300,
        },
      },
      {
        id: 84,
        text: '',
        groupedId: 'fixture-album',
        media: {
          kind: 'photo' as const,
          name: 'album-two.jpg',
          mimeType: 'image/jpeg',
          width: 300,
          height: 400,
        },
      },
      {
        id: 85,
        text: '',
        groupedId: 'fixture-album',
        media: {
          kind: 'photo' as const,
          name: 'album-three.jpg',
          mimeType: 'image/jpeg',
          width: 400,
          height: 300,
        },
      },
      {
        id: 86,
        text: 'Alice added Bob',
        service: {
          kind: 'users-added' as const,
          text: 'Alice added Bob',
          actorId: 'u:101',
          targetUserIds: ['u:202'],
        },
      },
      {
        id: 87,
        text: '',
        groupedId: 'fixture-captionless-album',
        media: {
          kind: 'photo' as const,
          name: 'album-frameless-one.jpg',
          mimeType: 'image/jpeg',
          width: 400,
          height: 300,
        },
      },
      {
        id: 88,
        text: '',
        groupedId: 'fixture-captionless-album',
        media: {
          kind: 'photo' as const,
          name: 'album-frameless-two.jpg',
          mimeType: 'image/jpeg',
          width: 300,
          height: 400,
        },
      },
      {
        id: 89,
        text: '',
        media: {
          kind: 'sticker' as const,
          name: 'sticker.webm',
          mimeType: 'video/webm',
          width: 512,
          height: 512,
        },
      },
    ];
    messages.forEach((message, index) =>
      fixture.emit({
        type: 'new-message',
        pts: 11 + index,
        ptsCount: 1,
        message: { ...message, peerId, senderId: peerId, date: date + index, outgoing: false },
      }),
    );
  });

  const voice = page.locator('article[data-message-id="81"]');
  await expect(voice.getByRole('button', { name: 'Play voice message' })).toBeVisible();
  await expect(voice).toHaveAttribute('data-media-kind', 'voice');

  const videoMessage = page.locator('article[data-message-id="82"]');
  const video = videoMessage.locator('video');
  await expect(video).toBeVisible();
  await expect(videoMessage).toHaveAttribute('data-media-kind', 'round-video');
  await expect(videoMessage.locator('.media-round-video-visual')).toHaveCSS('border-radius', '50%');

  await expect(video).not.toHaveAttribute('controls');
  await expect(videoMessage).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(videoMessage).toHaveCSS('border-top-width', '0px');
  await videoMessage.getByRole('button', { name: 'Play video message', exact: true }).click();
  await expect(
    videoMessage.getByRole('button', { name: 'Pause video message', exact: true }),
  ).toBeVisible();
  await videoMessage.getByRole('button', { name: 'Pause video message', exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await expect(videoMessage.getByRole('slider')).toHaveCount(0);
  await expect(videoMessage.locator('.round-video-controls')).toHaveCount(0);

  const videoSticker = page.locator('article[data-message-id="89"]');
  await expect(videoSticker.locator('video')).toHaveCount(1);
  await expect(videoSticker.locator('img')).toHaveCount(0);
  await expect(videoSticker.getByText('sticker.webm')).toHaveCount(0);

  const album = page.locator('article[data-message-id="83"] .media-album');
  await expect(album).toBeVisible();
  await expect(album.locator('.media-album-item')).toHaveCount(3);
  await expect
    .poll(() =>
      album.locator('.media-album-item').evaluateAll((items) =>
        items.map((item) => {
          const bounds = item.getBoundingClientRect();
          return bounds.height > 0 ? Math.round((bounds.width / bounds.height) * 100) : 0;
        }),
      ),
    )
    .toEqual([178, 177, 177]);
  await expect(album.locator('.media-album-row')).toHaveCount(2);
  await expect(album.locator('.media-album-row').first().locator('.media-album-item')).toHaveCount(
    1,
  );
  await expect(album.locator('.media-album-row').last().locator('.media-album-item')).toHaveCount(
    2,
  );
  await expect(album.locator('img').first()).toHaveCSS('object-fit', 'cover');
  await expect(album.locator('.media-album-actions')).toHaveCount(0);
  await expect(page.locator('article[data-message-id="83"]')).toContainText(
    'Three photos from Telegram',
  );
  await expect(page.locator('article[data-message-id="84"]')).toBeHidden();
  await expect(page.locator('article[data-message-id="85"]')).toBeHidden();
  await album.getByRole('button', { name: 'Open album-one.jpg fullscreen preview' }).click();
  const viewer = page.getByRole('dialog', { name: 'Media preview: album-one.jpg' });
  await expect(viewer.getByLabel('Attachment 1 of 3')).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Previous attachment' })).toBeDisabled();
  await viewer.getByRole('button', { name: 'Next attachment' }).click();
  await expect(page.getByRole('dialog', { name: 'Media preview: album-two.jpg' })).toBeVisible();
  await expect(page.getByLabel('Attachment 2 of 3')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  const lastViewer = page.getByRole('dialog', { name: 'Media preview: album-three.jpg' });
  await expect(lastViewer.getByLabel('Attachment 3 of 3')).toBeVisible();
  await expect(lastViewer.getByRole('button', { name: 'Next attachment' })).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('dialog', { name: 'Media preview: album-two.jpg' })).toBeVisible();
  await page.keyboard.press('Escape');
  const captionedAlbumMessage = page.locator('article[data-message-id="83"]');
  await expect(captionedAlbumMessage).toHaveClass(/message-has-album/u);
  await expect(captionedAlbumMessage).toHaveClass(/message-captioned-media/u);
  await expect(captionedAlbumMessage).not.toHaveClass(/message-media-surface/u);
  const captionedAlbumGeometry = await captionedAlbumMessage.evaluate((element) => {
    const albumElement = element.querySelector<HTMLElement>('.media-album')!;
    const albumRect = albumElement.getBoundingClientRect();
    const messageRect = element.getBoundingClientRect();
    const captionRect = element
      .querySelector<HTMLElement>('.message-body')!
      .getBoundingClientRect();
    return {
      widthDelta: messageRect.width - albumRect.width,
      topDelta: albumRect.top - messageRect.top,
      captionBelowAlbum: captionRect.top >= albumRect.bottom,
    };
  });
  expect(captionedAlbumGeometry.widthDelta).toBeCloseTo(0, 0);
  expect(captionedAlbumGeometry.topDelta).toBeCloseTo(0, 0);
  expect(captionedAlbumGeometry.captionBelowAlbum).toBe(true);

  await album.locator('.media-album-item').nth(1).focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Reply' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused();
  await expect(page.getByTestId('composer-reply')).toContainText('Photo');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...window.__televechaRuntimes!.values()][0]!.engine.snapshot().draftDetails['u:101']
            ?.reply?.messageId,
      ),
    )
    .toBe(84);

  const service = page.locator('article[data-message-id="86"]');
  await expect(service).toHaveClass(/message-service/u);
  await expect(service).toContainText('Alice added Bob');
  await expect(service.locator('footer')).toBeHidden();
  await expect(service.getByRole('button', { name: /Reply to message/u })).toHaveCount(0);

  const captionlessAlbumMessage = page.locator('article[data-message-id="87"]');
  const captionlessAlbum = captionlessAlbumMessage.locator('.media-album');
  await expect(captionlessAlbum.locator('.media-album-item')).toHaveCount(2);
  await expect(captionlessAlbumMessage).toHaveClass(/message-media-surface/u);
  const captionlessStyles = await captionlessAlbumMessage.evaluate((element) => {
    const albumElement = element.querySelector<HTMLElement>('.media-album')!;
    return {
      background: getComputedStyle(element).backgroundColor,
      padding: getComputedStyle(element).padding,
      footerPosition: getComputedStyle(element.querySelector('footer')!).position,
      widthDelta:
        element.getBoundingClientRect().width - albumElement.getBoundingClientRect().width,
    };
  });
  expect(captionlessStyles).toEqual({
    background: 'rgba(0, 0, 0, 0)',
    padding: '0px',
    footerPosition: 'absolute',
    widthDelta: 0,
  });
});

test('keeps the actual sender avatar beside a forwarded channel post', async ({ page }) => {
  await openReady(page, '/?chat=c%3A202');
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 91,
        peerId: 'c:202',
        senderId: 'u:101',
        text: 'Forwarded channel media',
        date: 1_700_005_000,
        outgoing: false,
        forwardedFrom: {
          name: 'Release Channel',
          peerId: 'c:202',
          messageId: 70,
          hasAvatar: true,
          avatarId: 'fixture-c:202',
          color: '#4ca184',
        },
        media: {
          kind: 'photo',
          name: 'forwarded.jpg',
          mimeType: 'image/jpeg',
          width: 640,
          height: 360,
        },
      },
    }),
  );

  await expect(
    page.locator(
      'article[data-message-id="91"] .message-sender-avatar [data-avatar-identity^="u:101:"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator('article[data-message-id="91"] .message-sender-avatar img'),
  ).toBeVisible();
  await expect(
    page.locator(
      'article[data-message-id="91"] .message-sender-avatar [data-avatar-identity^="forwarded:"]',
    ),
  ).toHaveCount(0);
  await expect(
    page.locator(
      'article[data-message-id="91"] .message-forwarded-avatar [data-avatar-identity="forwarded:c:202:fixture-c:202"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator('article[data-message-id="91"] .message-forwarded-avatar img'),
  ).toBeVisible();
  const forwardedHeaderGeometry = await page
    .locator('article[data-message-id="91"] .message-forwarded-from')
    .evaluate((header) => {
      const avatar = header.querySelector<HTMLElement>('.message-forwarded-avatar');
      const label = header.querySelector<HTMLElement>('.message-forwarded-label');
      if (!avatar || !label) throw new Error('Forwarded header geometry is incomplete.');
      const avatarBox = avatar.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      return {
        avatarWidth: avatarBox.width,
        avatarHeight: avatarBox.height,
        centerDelta: Math.abs(
          avatarBox.top + avatarBox.height / 2 - (labelBox.top + labelBox.height / 2),
        ),
      };
    });
  expect(forwardedHeaderGeometry.avatarWidth).toBeCloseTo(16, 0);
  expect(forwardedHeaderGeometry.avatarHeight).toBeCloseTo(16, 0);
  expect(forwardedHeaderGeometry.centerDelta).toBeLessThan(0.5);
});

test('centers a forwarded header vertically above its media', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 91,
        peerId: 'u:101',
        senderId: 'u:101',
        text: '',
        date: 1_700_005_000,
        outgoing: false,
        forwardedFrom: { name: 'Release Channel', peerId: 'c:202', messageId: 70 },
        media: {
          kind: 'photo',
          name: 'forwarded.jpg',
          mimeType: 'image/jpeg',
          width: 640,
          height: 360,
        },
      },
    }),
  );

  const gaps = await page.locator('article[data-message-id="91"]').evaluate((article) => {
    const header = article.querySelector<HTMLElement>('.message-forwarded-from');
    const media = article.querySelector<HTMLElement>('.media-attachment');
    if (!header || !media) throw new Error('Forwarded media geometry is incomplete.');
    const articleBox = article.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const mediaBox = media.getBoundingClientRect();
    return { top: headerBox.top - articleBox.top, bottom: mediaBox.top - headerBox.bottom };
  });
  expect(Math.abs(gaps.top - gaps.bottom)).toBeLessThan(0.5);
});

test('loads a video thumbnail without downloading the full video until preview opens', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  await expect(page.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  const before = await page.evaluate(() => ({
    preview: window.__televechaFixture?.stats.downloadMediaPreview ?? 0,
    full: window.__televechaFixture?.stats.downloadMediaFull ?? 0,
  }));

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 91,
        peerId: 'u:101',
        senderId: 'u:101',
        text: '',
        date: 1_700_005_000,
        outgoing: false,
        media: {
          kind: 'video',
          name: 'large-video.mp4',
          mimeType: 'video/mp4',
          size: 590_000_000,
          width: 1920,
          height: 1080,
          duration: 690,
        },
      },
    }),
  );

  const message = page.locator('article[data-message-id="91"]');
  await expect(message.getByRole('img', { name: 'large-video.mp4' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__televechaFixture?.stats.downloadMediaPreview ?? 0))
    .toBeGreaterThan(before.preview);
  expect(await page.evaluate(() => window.__televechaFixture?.stats.downloadMediaFull ?? 0)).toBe(
    before.full,
  );

  await message.getByRole('button', { name: 'Open large-video.mp4 fullscreen preview' }).click();
  await expect(page.getByRole('dialog', { name: 'Media preview: large-video.mp4' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__televechaFixture?.stats.downloadMediaFull ?? 0))
    .toBe(before.full + 1);
});

test('loads the original photo instead of a Telegram thumbnail', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 92,
        peerId: 'u:101',
        senderId: 'u:101',
        text: '',
        date: 1_700_005_001,
        outgoing: false,
        media: {
          kind: 'photo',
          name: 'full-resolution.jpg',
          mimeType: 'image/jpeg',
          width: 1920,
          height: 1080,
        },
      },
    }),
  );

  await expect(page.getByRole('img', { name: 'full-resolution.jpg' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__televechaFixture?.stats.downloadMediaRequests
          .filter((request) => request.peerId === 'u:101' && request.messageId === 92)
          .map((request) => request.preview),
      ),
    )
    .toEqual([false]);
});
