import { expect, test } from '@playwright/test';

import { fixtureStats, openReady, selectAlice } from './helpers';

test.beforeEach(async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
});

for (const reactionCount of [1, 5, 7]) {
  test(`lays out ${reactionCount} image document reactions before the timestamp`, async ({
    page,
  }) => {
    await page.evaluate(
      (count) =>
        window.__televechaFixture?.emit({
          type: 'new-message',
          pts: 11,
          ptsCount: 1,
          message: {
            id: 81,
            peerId: 'u:101',
            senderId: 'self',
            text: 'вроде неплохо, но пока не проверял нормально',
            date: 1_700_002_000,
            editedAt: 1_700_002_001,
            outgoing: true,
            media: { kind: 'file', name: 'image.png', mimeType: 'image/png', size: 400_384 },
            reactions: ['🔥', '👍', '❤️', '🎉', '😁', '🤔', '👀']
              .slice(0, count)
              .map((emoji) => ({ emoji, count: 1, chosen: false })),
          },
        }),
      reactionCount,
    );
    const message = page.locator('article[data-message-id="81"]');
    await expect(message.locator('.reaction')).toHaveCount(reactionCount);
    await expect(message.locator('.reaction').first()).toBeVisible();

    for (const width of [1326, 390]) {
      await page.setViewportSize({ width, height: 784 });
      const geometry = await message.evaluate((element) => {
        const body = element.querySelector('.message-body')!.getBoundingClientRect();
        const reaction = element.querySelector('.reaction')!.getBoundingClientRect();
        const footer = element.querySelector('footer')!.getBoundingClientRect();
        const buttons = [...element.querySelectorAll('.reaction')].map((button) =>
          button.getBoundingClientRect(),
        );
        const gap = parseFloat(getComputedStyle(element.querySelector('.message-copy')!).columnGap);
        // Telegram Desktop fills reaction rows first, then reserves time after the last button.
        let left = body.left;
        let top = reaction.top;
        const placements = buttons.map((button) => {
          if (left > body.left && left + button.width > body.right) {
            left = body.left;
            top += button.height + gap;
          }
          const delta = { x: button.left - left, y: button.top - top };
          left += button.width + gap;
          return delta;
        });
        const last = buttons.at(-1)!;
        const timeFits = last.right + gap + footer.width <= body.right;
        return {
          captionGap: reaction.top - body.bottom,
          leftDelta: reaction.left - body.left,
          placements,
          timeFits,
          bottomDelta: last.bottom - footer.bottom,
          timeGap: footer.top - last.bottom,
          separation: footer.left - last.right,
        };
      });
      expect(geometry.captionGap).toBeGreaterThanOrEqual(0);
      expect(geometry.captionGap).toBeLessThanOrEqual(6);
      expect(geometry.leftDelta).toBeCloseTo(0, 0);
      for (const placement of geometry.placements) {
        expect(placement.x).toBeCloseTo(0, 0);
        expect(placement.y).toBeCloseTo(0, 0);
      }
      if (geometry.timeFits) {
        expect(geometry.bottomDelta).toBeCloseTo(0, 0);
        expect(geometry.separation).toBeGreaterThan(0);
      } else {
        expect(geometry.timeGap).toBeGreaterThanOrEqual(0);
        expect(geometry.timeGap).toBeLessThanOrEqual(6);
      }
    }
  });
}

test('opens image documents from a file card and keeps download separate', async ({ page }) => {
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        senderName: 'Alice Fixture',
        text: 'Original diagram',
        date: 1_700_002_000,
        outgoing: false,
        media: {
          kind: 'file',
          name: 'diagram.png',
          mimeType: 'image/png',
          size: 42_000,
          width: 320,
          height: 180,
        },
      },
    }),
  );

  const message = page.locator('article[data-message-id="81"]');
  const card = message.getByRole('button', { name: 'Open diagram.png fullscreen preview' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('41 KB · image/png');
  await expect(message.locator('.media-file-thumbnail img')).toBeVisible();
  const fileRows = await message.evaluate((element) => {
    const status = element.querySelector<HTMLElement>('.media-file-copy small')!;
    const action = element.querySelector<HTMLElement>('.media-file-download')!;
    return {
      statusBottom: status.getBoundingClientRect().bottom,
      actionTop: action.getBoundingClientRect().top,
      actionPosition: getComputedStyle(action).position,
    };
  });
  expect(fileRows.actionPosition).toBe('static');
  expect(fileRows.actionTop).toBeGreaterThanOrEqual(fileRows.statusBottom);

  const downloadsBefore = (await fixtureStats(page))?.downloadMedia ?? 0;
  await card.click();
  const viewer = page.getByRole('dialog', { name: 'Media preview: diagram.png' });
  const previewImage = viewer.getByRole('img', { name: 'diagram.png' });
  await expect(previewImage).toBeVisible();
  await expect(previewImage).toHaveClass(/media-viewer-origin/u);
  await expect(previewImage).toHaveCSS('animation-name', 'media-viewer-open');
  await expect(viewer).toContainText('Alice Fixture');
  await expect(viewer).toContainText('Original diagram');
  expect((await fixtureStats(page))?.downloadMedia).toBe(downloadsBefore + 1);

  await viewer.getByRole('button', { name: 'Close media preview' }).click();
  await expect(card).toBeFocused();
  await card.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Media preview: diagram.png' })).toBeVisible();
  expect((await fixtureStats(page))?.downloadMedia).toBe(downloadsBefore + 1);
});

test('keeps dragging a zoomed long image across updates and outside the image area', async ({
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
        text: '',
        date: Math.floor(Date.now() / 1000),
        outgoing: false,
        media: { kind: 'photo', name: 'long.png', mimeType: 'image/png', width: 200, height: 2000 },
      },
    }),
  );
  await page.getByRole('button', { name: 'Open long.png fullscreen preview' }).click();
  const viewer = page.getByRole('dialog', { name: 'Media preview: long.png' });
  const image = viewer.getByRole('img');
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  await expect(image).toHaveAttribute('data-zoom', '2');
  await expect(image).toHaveAttribute('draggable', 'false');
  const area = await viewer.locator('.media-viewer-content').boundingBox();
  const x = area!.x + area!.width / 2;
  const y = area!.y + area!.height / 2;
  const pan = () =>
    image.evaluate((element) => {
      const transform = new DOMMatrix(getComputedStyle(element).transform);
      return { x: Math.round(transform.m41), y: Math.round(transform.m42) };
    });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(image).toHaveCSS('cursor', 'grabbing');
  await expect(image).toHaveCSS('transition-duration', '0s');
  await page.mouse.move(x + 150, y + 100, { steps: 20 });
  await expect.poll(pan).toEqual({ x: 150, y: 100 });
  await page.mouse.move(x, 10, { steps: 20 });
  await expect.poll(pan).toEqual({ x: 0, y: Math.round(10 - y) });
  await page.mouse.move(x - 120, y - 80, { steps: 20 });
  await expect.poll(pan).toEqual({ x: -120, y: -80 });
  await page.mouse.up();
  await expect(image).toHaveCSS('cursor', 'grab');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 10 });
  await expect.poll(pan).toEqual({ x: -60, y: -40 });
  await page.mouse.up();
  await viewer.getByRole('button', { name: 'Zoom out' }).click();
  await expect.poll(pan).toEqual({ x: 0, y: 0 });
});

test('offers image viewer actions, zoom, and adjacent-message navigation', async ({ page }) => {
  await page.evaluate(() => {
    for (const [id, name] of [
      [81, 'first.png'],
      [82, 'second.png'],
    ] as const) {
      window.__televechaFixture?.emit({
        type: 'new-message',
        pts: id - 70,
        ptsCount: 1,
        message: {
          id,
          peerId: 'u:101',
          senderId: 'u:101',
          senderName: 'Alice Fixture',
          text: `Caption for ${name}`,
          date: 1_700_002_000 + id,
          outgoing: false,
          media: { kind: 'file', name, mimeType: 'image/png', size: 4_096 },
        },
      });
    }
  });

  await page.getByRole('button', { name: 'Open first.png fullscreen preview' }).click();
  let viewer = page.getByRole('dialog', { name: 'Media preview: first.png' });
  await expect(viewer.getByRole('button', { name: 'Download first.png' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Forward message' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Delete message' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Go to message' })).toBeVisible();

  const image = viewer.getByRole('img', { name: 'first.png' });
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  await expect(image).toHaveAttribute('data-zoom', '2');
  await image.dblclick();
  await expect(image).toHaveAttribute('data-zoom', '1');

  await viewer.getByRole('button', { name: 'Next attachment' }).click();
  viewer = page.getByRole('dialog', { name: 'Media preview: second.png' });
  await expect(viewer).toContainText('Caption for second.png');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('dialog', { name: 'Media preview: first.png' })).toBeVisible();
});

test('reveals media spoilers and suppresses export actions for protected media', async ({
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
        senderName: 'Alice Fixture',
        text: 'Protected spoiler',
        date: 1_700_002_000,
        outgoing: false,
        protected: true,
        media: {
          kind: 'photo',
          name: 'secret.jpg',
          mimeType: 'image/jpeg',
          spoiler: true,
          width: 320,
          height: 180,
        },
      },
    }),
  );

  const message = page.locator('article[data-message-id="81"]');
  await expect(
    message.getByRole('button', { name: 'Reveal media spoiler secret.jpg' }),
  ).toBeVisible();
  await expect(
    message.getByRole('button', { name: 'Open secret.jpg fullscreen preview' }),
  ).toHaveCount(0);
  await message.getByRole('button', { name: 'Reveal media spoiler secret.jpg' }).click();
  await message.getByRole('button', { name: 'Open secret.jpg fullscreen preview' }).click();

  const viewer = page.getByRole('dialog', { name: 'Media preview: secret.jpg' });
  await expect(viewer.getByRole('button', { name: 'Download secret.jpg' })).toHaveCount(0);
  await expect(viewer.getByRole('button', { name: 'Forward message' })).toHaveCount(0);
  await expect(viewer.getByRole('button', { name: 'Copy image' })).toHaveCount(0);
});

test('reports and cancels an attachment download', async ({ page }) => {
  await page.goto('/?scenario=held-media-download');
  await selectAlice(page);
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: '',
        date: 1_700_002_000,
        outgoing: false,
        media: { kind: 'file', name: 'held-image.png', mimeType: 'image/png', size: 1_000_000 },
      },
    }),
  );

  const message = page.locator('article[data-message-id="81"]');
  await message.getByRole('button', { name: 'Open held-image.png fullscreen preview' }).click();
  await expect.poll(async () => (await fixtureStats(page))?.downloadMedia ?? 0).toBeGreaterThan(0);
  await expect(message.getByText('25% downloaded')).toBeVisible();
  await message.getByRole('button', { name: 'Cancel download held-image.png' }).click();
  await expect(page.getByRole('dialog', { name: 'Media preview: held-image.png' })).toHaveCount(0);
  await expect(
    message.getByRole('button', { name: 'Open held-image.png fullscreen preview' }),
  ).toBeEnabled();
});

test('loads original photos and stores the full blob in IndexedDB', async ({ page }) => {
  await expect(page.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  // Other visible attachments download too; inspect this photo's durable cache entry.

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
        const original = records.find((record) => record.key.startsWith('media:u:101:78:'));
        const preview = records.find((record) => record.key.startsWith('preview:media:u:101:78:'));
        return {
          hasOriginal: Boolean(original?.blob.size),
          hasPreview: Boolean(preview?.blob.size),
        };
      }),
    )
    .toEqual({ hasOriginal: true, hasPreview: false });
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
      messageTopRightRadius: messageStyle.borderTopRightRadius,
      mediaTopRightRadius: getComputedStyle(
        element.querySelector<HTMLElement>('.media-attachment')!,
      ).borderTopRightRadius,
      message: { top: messageRect.top, right: messageRect.right, left: messageRect.left },
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
  expect(styles.mediaTopRightRadius).toBe(styles.messageTopRightRadius);
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

test('widens an extreme portrait preview when its caption needs more room', async ({ page }) => {
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 85,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'A long caption that should determine the bubble width instead of forcing every line into an extremely narrow portrait column.',
        date: 1_700_002_004,
        outgoing: false,
        forwardedFrom: { name: 'A channel with a long title' },
        media: {
          kind: 'photo',
          name: 'captioned-extreme-portrait.jpg',
          mimeType: 'image/jpeg',
          width: 100,
          height: 1_000,
        },
      },
    }),
  );

  const message = page.locator('article[data-message-id="85"]');
  await expect(message.getByRole('img', { name: 'captioned-extreme-portrait.jpg' })).toBeVisible();
  const geometry = await message.evaluate((element) => {
    const media = element.querySelector<HTMLElement>('.media-visual')!;
    return {
      bubbleWidth: element.getBoundingClientRect().width,
      previewRatio: media.getBoundingClientRect().width / media.getBoundingClientRect().height,
    };
  });
  expect(geometry.bubbleWidth).toBeGreaterThanOrEqual(380);
  expect(geometry.previewRatio).toBeGreaterThanOrEqual(1);
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
  const photoTrigger = page.getByRole('button', { name: 'Open fixture.jpg fullscreen preview' });
  await expect(photoTrigger).toBeVisible();
  const fullDownloadsBefore = (await fixtureStats(page))?.downloadMediaFull ?? 0;
  await photoTrigger.click();
  const photoViewer = page.getByRole('dialog', { name: 'Media preview: fixture.jpg' });
  const fullscreenPhoto = photoViewer.getByRole('img', { name: 'fixture.jpg' });
  await expect(fullscreenPhoto).toBeVisible();
  await expect(photoViewer.getByRole('button', { name: 'Close media preview' })).toBeFocused();
  expect((await fixtureStats(page))?.downloadMediaFull).toBe(fullDownloadsBefore);
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
          size: 17_428_252,
          width: 320,
          height: 180,
          duration: 45.369,
        },
      },
    }),
  );
  const videoMessage = page.locator('article[data-message-id="81"]');
  await expect(videoMessage.getByText('16.6 MB')).toBeVisible();
  await expect(videoMessage.getByText('0:45')).toBeVisible();
  await expect(videoMessage.locator('.media-video-play')).toBeVisible();
  const thumbnailUrl = await videoMessage.locator('.media-visual > img').getAttribute('src');
  await videoMessage.locator('.media-visual').hover();
  const inlineVideo = videoMessage.locator('video[aria-label="fixture.mp4. Hover to play."]');
  await expect(inlineVideo).toBeVisible();
  await expect(inlineVideo).not.toHaveAttribute('src', thumbnailUrl!);
  await expect(videoMessage.locator('.media-video-play')).toBeHidden();
  await page.reload();
  await selectAlice(page);
  await expect(page.locator('article[data-message-id="81"] .media-visual > img')).toBeVisible();
  await page.getByRole('button', { name: 'Open fixture.mp4 fullscreen preview' }).click();
  const videoViewer = page.getByRole('dialog', { name: 'Media preview: fixture.mp4' });
  const video = videoViewer.locator('video[controls]');
  await expect(video).toBeVisible();
  await expect(video).not.toHaveAttribute('src', thumbnailUrl!);
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

test('keeps cached chats usable while reconnecting without redownloading avatars', async ({
  page,
}) => {
  await page.goto('/?scenario=held-connect');
  await expect(page.getByText('Connecting to Telegram')).toBeVisible();
  await page.evaluate(() => window.__televechaFixture?.releaseConnect());
  await expect(page.locator('[data-testid="chat-list"] img').first()).toBeVisible();

  await page.reload();

  await expect(page.locator('[data-testid="chat-list"] img').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Reconnecting… Retry Telegram connection' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);

  await page.evaluate(() => window.__televechaFixture?.releaseConnect());

  await expect(page.locator('[data-testid="chat-list"] img').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Reconnecting… Retry Telegram connection' }),
  ).toHaveCount(0);
  expect((await fixtureStats(page))?.downloadAvatar).toBe(0);
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

test('waits for Telegram to reconnect before loading uncached message media', async ({ page }) => {
  await page.goto('/?scenario=held-connect&chat=u%3A101');
  await expect(page.getByText('Connecting to Telegram')).toBeVisible();
  await page.evaluate(() => window.__televechaFixture?.releaseConnect());
  await expect(page.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const request = indexedDB.open('televecha-e2e-held-connect');
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

  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Reconnecting… Retry Telegram connection' }),
  ).toBeVisible();
  await expect(page.getByText(/media requested before connection was ready/i)).toHaveCount(0);
  expect((await fixtureStats(page))?.downloadMedia).toBe(0);

  await page.evaluate(() => window.__televechaFixture?.releaseConnect());

  await expect(page.getByRole('img', { name: 'fixture.jpg', exact: true })).toBeVisible();
  await expect(page.getByText(/media requested before connection was ready/i)).toHaveCount(0);
  expect((await fixtureStats(page))?.downloadMedia).toBeGreaterThan(0);
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

test('downloads a generic file on demand from its file card', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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
        media: { kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', size: 123 },
      },
    }),
  );

  const attachment = page.locator('article[data-message-id="81"]');
  const fileRequests = async () =>
    (await fixtureStats(page))?.downloadMediaRequests.filter(
      (request) => request.peerId === 'u:101' && request.messageId === 81,
    ) ?? [];
  await expect(attachment.getByRole('button', { name: 'Download report.pdf' })).toBeVisible();
  expect(await fileRequests()).toEqual([]);
  const download = page.waitForEvent('download');
  await attachment.getByRole('button', { name: 'Download report.pdf' }).click();
  expect((await download).suggestedFilename()).toBe('report.pdf');
  await expect(attachment.getByRole('button', { name: 'Download report.pdf' })).toBeVisible();
  expect(await fileRequests()).toEqual([
    { peerId: 'u:101', messageId: 81, name: 'report.pdf', preview: false },
  ]);

  await attachment.getByRole('button', { name: 'Download report.pdf' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy filename' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('report.pdf');
});
