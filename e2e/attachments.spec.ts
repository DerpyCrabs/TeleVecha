import { expect, test } from '@playwright/test';

import { fixtureStats, openReady, selectAlice } from './helpers';

test.beforeEach(async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
});

test('loads photo media and stores the blob in IndexedDB', async ({ page }) => {
  await expect(page.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  expect((await fixtureStats(page))?.downloadMedia).toBe(2);

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open('televecha-e2e');
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const records = await new Promise<Array<{ key: string; blob: Blob }>>((resolve, reject) => {
          const lookup = database.transaction('files').objectStore('files').getAll();
          lookup.onsuccess = () => resolve(lookup.result);
          lookup.onerror = () => reject(lookup.error);
        });
        const value = records.find((record) => record.key.startsWith('media:u:101:78:'));
        return value?.blob.size ?? 0;
      }),
    )
    .toBeGreaterThan(0);
});

test('renders a single photo with one media canvas instead of nested containers', async ({
  page,
}) => {
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Photo caption',
        date: 1_700_002_000,
        outgoing: false,
        media: {
          kind: 'photo',
          name: 'portrait.jpg',
          mimeType: 'image/jpeg',
          width: 300,
          height: 400,
        },
      },
    }),
  );

  const message = page.locator('article[data-message-id="81"]');
  await expect(message.getByRole('img', { name: 'portrait.jpg' })).toBeVisible();
  await expect(message).toHaveClass(/message-captioned-media/u);
  const styles = await message.evaluate((element) => {
    const visual = element.querySelector<HTMLElement>('.media-visual')!;
    const image = visual.querySelector<HTMLImageElement>(':scope > img')!;
    const messageStyle = getComputedStyle(element);
    const messageRect = element.getBoundingClientRect();
    const bodyRect = element.querySelector<HTMLElement>('.message-body')!.getBoundingClientRect();
    const footerRect = element.querySelector<HTMLElement>('footer')!.getBoundingClientRect();
    const visualRect = visual.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    return {
      background: messageStyle.backgroundColor,
      border: messageStyle.borderWidth,
      padding: messageStyle.padding,
      message: {
        top: messageRect.top,
        right: messageRect.right,
        left: messageRect.left,
      },
      visual: {
        top: visualRect.top,
        right: visualRect.right,
        bottom: visualRect.bottom,
        left: visualRect.left,
        height: visualRect.height,
      },
      image: {
        top: imageRect.top,
        right: imageRect.right,
        bottom: imageRect.bottom,
        left: imageRect.left,
        height: imageRect.height,
        background: getComputedStyle(image).backgroundColor,
      },
      captionBelowMedia: bodyRect.top >= visualRect.bottom,
      captionAndTimeShareLine:
        Math.min(bodyRect.bottom, footerRect.bottom) - Math.max(bodyRect.top, footerRect.top) > 0,
    };
  });
  expect(styles.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(styles.border).toBe('0px');
  expect(styles.padding).toBe('0px');
  expect(styles.visual.top).toBeCloseTo(styles.message.top, 0);
  expect(styles.visual.right).toBeCloseTo(styles.message.right, 0);
  expect(styles.visual.left).toBeCloseTo(styles.message.left, 0);
  expect(styles.visual.height).toBe(384);
  expect(styles.image.background).toBe('rgba(0, 0, 0, 0)');
  expect(styles.image.top).toBeCloseTo(styles.visual.top, 0);
  expect(styles.image.right).toBeCloseTo(styles.visual.right, 0);
  expect(styles.image.bottom).toBeCloseTo(styles.visual.bottom, 0);
  expect(styles.image.left).toBeCloseTo(styles.visual.left, 0);
  expect(styles.image.height).toBeCloseTo(styles.visual.height, 0);
  expect(styles.captionBelowMedia).toBe(true);
  expect(styles.captionAndTimeShareLine).toBe(true);
});

test('removes the outer frame from a media-only single photo', async ({ page }) => {
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 82,
        peerId: 'u:101',
        senderId: 'u:101',
        text: '',
        date: 1_700_002_001,
        outgoing: false,
        media: {
          kind: 'photo',
          name: 'frameless.jpg',
          mimeType: 'image/jpeg',
          width: 300,
          height: 400,
        },
      },
    }),
  );

  const message = page.locator('article[data-message-id="82"]');
  await expect(message.getByRole('img', { name: 'frameless.jpg' })).toBeVisible();
  await expect(message).toHaveClass(/message-media-surface/u);
  const styles = await message.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    padding: getComputedStyle(element).padding,
    footerPosition: getComputedStyle(element.querySelector('footer')!).position,
    footerOpacity: getComputedStyle(element.querySelector('footer')!).opacity,
    attachmentMargin: getComputedStyle(element.querySelector('.media-attachment')!).margin,
  }));
  expect(styles).toEqual({
    background: 'rgba(0, 0, 0, 0)',
    padding: '0px',
    footerPosition: 'absolute',
    footerOpacity: '0',
    attachmentMargin: '0px',
  });
  await message.hover();
  await expect(message.locator('footer')).toHaveCSS('opacity', '1');
});

test('keeps decorated and extreme portrait photos free of an outer frame', async ({ page }) => {
  await page.evaluate(() => {
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 83,
        peerId: 'u:101',
        senderId: 'u:101',
        text: '',
        date: 1_700_002_002,
        outgoing: false,
        media: {
          kind: 'photo',
          name: 'reacted.jpg',
          mimeType: 'image/jpeg',
          width: 300,
          height: 400,
        },
        reactions: [{ emoji: '👍', count: 1, chosen: false }],
      },
    });
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 12,
      ptsCount: 1,
      message: {
        id: 84,
        peerId: 'u:101',
        senderId: 'u:101',
        text: '',
        date: 1_700_002_003,
        outgoing: false,
        media: {
          kind: 'photo',
          name: 'extreme-portrait.jpg',
          mimeType: 'image/jpeg',
          width: 100,
          height: 1_000,
        },
      },
    });
  });

  const decorated = page.locator('article[data-message-id="83"]');
  await expect(decorated.getByRole('img', { name: 'reacted.jpg' })).toBeVisible();
  await expect(decorated).toHaveClass(/message-captioned-media/u);
  const decoratedFrame = await decorated.evaluate((element) => {
    const media = element.querySelector<HTMLElement>('.media-attachment')!;
    const articleRect = element.getBoundingClientRect();
    const mediaRect = media.getBoundingClientRect();
    return {
      border: getComputedStyle(element).borderWidth,
      padding: getComputedStyle(element).padding,
      widthDelta: articleRect.width - mediaRect.width,
    };
  });
  expect(decoratedFrame).toEqual({ border: '0px', padding: '0px', widthDelta: 0 });

  const extreme = page.locator('article[data-message-id="84"]');
  const extremeImage = extreme.getByRole('img', { name: 'extreme-portrait.jpg' });
  await expect(extremeImage).toBeVisible();
  await expect(extreme).toHaveClass(/message-media-cropped/u);
  await expect(extremeImage).toHaveCSS('object-fit', 'cover');
  const extremeRatio = await extreme.locator('.media-visual').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.width / bounds.height;
  });
  expect(extremeRatio).toBeCloseTo(0.5, 2);

  await extreme
    .getByRole('button', { name: 'Open extreme-portrait.jpg fullscreen preview' })
    .click();
  const viewer = page.getByRole('dialog', { name: 'Media preview: extreme-portrait.jpg' });
  const fullscreenImage = viewer.getByRole('img', { name: 'extreme-portrait.jpg' });
  const bounds = await viewer.locator('.media-viewer-content').evaluate((content) => {
    const image = content.querySelector('img')!;
    const contentRect = content.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    return {
      naturalRatio: image.naturalWidth / image.naturalHeight,
      objectFit: getComputedStyle(image).objectFit,
      content: { width: contentRect.width, height: contentRect.height },
      image: { width: imageRect.width, height: imageRect.height },
    };
  });
  expect(bounds.naturalRatio).toBeCloseTo(0.1, 2);
  expect(bounds.objectFit).toBe('contain');
  expect(bounds.image.width).toBeLessThanOrEqual(bounds.content.width);
  expect(bounds.image.height).toBeLessThanOrEqual(bounds.content.height);
  await fullscreenImage.press('Escape');
});

test('shows a retry control when automatic media loading fails', async ({ page }) => {
  await openReady(page, '/?scenario=media-download-retry');
  await selectAlice(page);
  const retry = page.getByRole('button', { name: 'Retry loading fixture.jpg' });
  await expect(retry).toBeVisible();

  await retry.click();

  await expect(page.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
});

test('opens photo and video attachments in a fullscreen viewer', async ({ page }) => {
  const downloadsBefore = (await fixtureStats(page))?.downloadMedia;
  const photoTrigger = page.getByRole('button', { name: 'Open fixture.jpg fullscreen preview' });
  await photoTrigger.click();
  const photoViewer = page.getByRole('dialog', { name: 'Media preview: fixture.jpg' });
  const fullscreenPhoto = photoViewer.getByRole('img', { name: 'fixture.jpg' });
  await expect(fullscreenPhoto).toBeVisible();
  await expect(photoViewer.getByRole('button', { name: 'Close media preview' })).toBeFocused();
  expect((await fixtureStats(page))?.downloadMedia).toBe(downloadsBefore);
  await fullscreenPhoto.click({ position: { x: 160, y: 90 } });
  await expect(photoViewer).toBeVisible();
  const viewerContent = photoViewer.locator('.media-viewer-content');
  const contentBox = await viewerContent.boundingBox();
  expect(contentBox).not.toBeNull();
  await viewerContent.click({ position: { x: 2, y: contentBox!.height / 2 } });
  await expect(photoViewer).toHaveCount(0);
  await expect(photoTrigger).toBeFocused();

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Fixture video',
        date: 1_700_002_000,
        outgoing: false,
        media: {
          kind: 'video',
          name: 'fixture.mp4',
          mimeType: 'video/mp4',
          width: 320,
          height: 180,
        },
      },
    }),
  );
  await page.getByRole('button', { name: 'Open fixture.mp4 fullscreen preview' }).click();
  const videoViewer = page.getByRole('dialog', { name: 'Media preview: fixture.mp4' });
  const video = videoViewer.locator('video[controls]');
  await expect(video).toBeVisible();
  await expect(videoViewer.getByRole('button', { name: 'Close media preview' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(video).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(videoViewer.getByRole('button', { name: 'Close media preview' })).toBeFocused();
  await videoViewer.getByRole('button', { name: 'Close media preview' }).click();
  await expect(videoViewer).toHaveCount(0);
});

test('uses cached avatars and media after reload instead of downloading again', async ({
  page,
}) => {
  await expect(page.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="chat-list"] img').first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="chat-list"] img').first()).toBeVisible();

  const stats = await fixtureStats(page);
  expect(stats?.downloadMedia).toBe(0);
  expect(stats?.downloadAvatar).toBe(0);
});

test('shows cached avatars during startup without an outage warning', async ({ page }) => {
  await page.goto('/?scenario=held-connect');
  await expect(page.getByText('Connecting to Telegram')).toBeVisible();
  await page.evaluate(() => window.__televechaFixture?.releaseConnect());
  await expect(page.locator('[data-testid="chat-list"] img').first()).toBeVisible();

  await page.reload();

  await expect(page.locator('[data-testid="chat-list"] img').first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'connecting' })).toBeVisible();
  await expect(page.getByText('Connecting to Telegram. Showing cached data.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  expect((await fixtureStats(page))?.downloadAvatar).toBe(0);

  await page.evaluate(() => window.__televechaFixture?.releaseConnect());
});

test('loads cached-dialog avatars after a delayed Telegram connection becomes ready', async ({
  page,
}) => {
  await expect(page.locator('[data-testid="chat-list"] img').first()).toBeVisible();
  await page.evaluate(async () => {
    const request = indexedDB.open('televecha-e2e');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const clear = database.transaction('files', 'readwrite').objectStore('files').clear();
      clear.onsuccess = () => resolve();
      clear.onerror = () => reject(clear.error);
    });
    database.close();
  });

  await page.goto('/?scenario=held-connect');
  await expect(page.getByText('Connecting to Telegram')).toBeVisible();
  expect((await fixtureStats(page))?.downloadAvatar).toBe(0);
  await page.evaluate(() => window.__televechaFixture?.releaseConnect());
  await expect(page.getByText('Connecting to Telegram')).toHaveCount(0);
  await expect(page.locator('[data-testid="chat-list"] img').first()).toBeVisible();
  expect((await fixtureStats(page))?.downloadAvatar).toBeGreaterThan(0);
});

test('shows upload progress, preserves the caption, and completes a file upload', async ({
  page,
}) => {
  await page.goto('/?scenario=held-upload');
  await selectAlice(page);
  await page.getByRole('textbox', { name: 'Message' }).fill('Fixture caption');
  await page.locator('input[type="file"]').setInputFiles('e2e/fixtures/report.txt');
  await expect(page.getByTestId('composer-attachment')).toContainText('report.txt');
  expect((await fixtureStats(page))?.sendFile).toBe(0);
  await page.getByRole('button', { name: 'Send message' }).click();

  const upload = page.locator('article.message', { hasText: 'Fixture caption' });
  await expect(upload).toContainText('report.txt');
  await expect(upload).toContainText('25%');
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  await page.evaluate(() => window.__televechaFixture?.releaseUpload());
  await expect(upload).not.toContainText('25%');
  await expect(upload.locator('footer')).toHaveAttribute('aria-label', /Message status: sent$/u);
});

test('classifies WebP uploads as stickers', async ({ page }) => {
  await page.goto('/?scenario=held-upload');
  await selectAlice(page);
  await page.locator('input[type="file"]').setInputFiles('e2e/fixtures/sticker.webp');
  await expect(page.getByTestId('composer-attachment')).toContainText('sticker.webp');
  await page.getByRole('button', { name: 'Send message' }).click();

  const upload = page.locator('article[data-media-kind="sticker"]');
  await expect(upload).toContainText('sticker.webp');
  await page.evaluate(() => window.__televechaFixture?.releaseUpload());
});

test('downloads a generic file on demand and replaces the button with a download link', async ({
  page,
}) => {
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Attached report',
        date: 1_700_002_000,
        outgoing: false,
        media: {
          kind: 'file',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          size: 123,
        },
      },
    }),
  );

  const attachment = page.locator('article[data-message-id="81"]');
  const downloadsBefore = (await fixtureStats(page))?.downloadMedia ?? 0;
  await attachment.getByRole('button', { name: /report.pdf/ }).click();
  const link = attachment.getByRole('link', { name: /report.pdf/ });
  await expect(link).toHaveAttribute('download', 'report.pdf');
  expect((await fixtureStats(page))?.downloadMedia).toBe(downloadsBefore + 1);
});
