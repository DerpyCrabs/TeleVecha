import { expect, test } from '@playwright/test';

import { fixtureStats, openReady, selectAlice } from './helpers';

const imagePath = 'e2e/fixtures/outgoing-media.png';
const wideImage = (
  globalThis as unknown as { Buffer: { from(value: string, encoding: 'base64'): Uint8Array } }
).Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAZAAAADIAQMAAAD82yWhAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURWZQ2P///6CHLScAAAABYktHRAH/Ai3eAAAAB3RJTUUH6ggXFDI3yFdMcQAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOC0yM1QyMDo1MDo1NSswMDowMADZTO4AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDgtMjNUMjA6NTA6NTUrMDA6MDBxhPRSAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA4LTIzVDIwOjUwOjU1KzAwOjAwJpHVjQAAACFJREFUaN7twTEBAAAAwqD1T20ND6AAAAAAAAAAAACAFwMn2AABnEBoEQAAAABJRU5ErkJggg==',
  'base64',
);

test.beforeEach(async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
});

test('sends adjacent media as a Telegram album and a file-mode item separately', async ({
  page,
}) => {
  await page.locator('input[type="file"]').setInputFiles([imagePath, imagePath, imagePath]);
  const attachments = page.getByTestId('composer-attachment');
  await expect(attachments).toHaveCount(3);
  await attachments.nth(2).getByRole('button', { name: 'File', exact: true }).click();
  await expect(
    attachments.nth(2).getByRole('button', { name: 'File', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: 'Message' }).fill('Grouped upload caption');

  await page.getByRole('button', { name: 'Send message' }).click();

  await expect.poll(async () => (await fixtureStats(page))?.sendAlbum).toBe(1);
  await expect.poll(async () => (await fixtureStats(page))?.sendFile).toBe(1);
  const album = page.locator('.media-album').last();
  await expect(album).toHaveAttribute('data-album-size', '2');
  await expect(album).toBeVisible();
  await expect(page.locator('article[data-media-kind="file"]').last()).toContainText(
    'outgoing-media.png',
  );
});

test('shows image batches as large tiles with batch actions', async ({ page }) => {
  await page
    .locator('input[type="file"]')
    .setInputFiles([imagePath, imagePath, imagePath, imagePath, imagePath]);

  const batch = page.getByLabel('Staged attachments');
  const attachments = page.getByTestId('composer-attachment');
  await expect(batch).toHaveClass(/composer-image-batch/u);
  await expect(batch.getByText('5 images')).toBeVisible();
  await expect(attachments).toHaveCount(5);

  const bounds = await attachments.evaluateAll((elements) =>
    elements.map((element) => {
      const { width, height, top } = element.getBoundingClientRect();
      return { width, height, top };
    }),
  );
  expect(bounds.every(({ width, height }) => width >= 220 && height >= 230)).toBe(true);
  expect(new Set(bounds.map(({ top }) => Math.round(top))).size).toBeGreaterThan(1);

  await batch
    .getByRole('group', { name: 'Send all as' })
    .getByRole('button', { name: 'Files' })
    .click();
  for (const attachment of await attachments.all()) {
    await expect(attachment.getByRole('button', { name: 'File', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }

  await batch.getByRole('button', { name: 'Clear' }).click();
  await expect(attachments).toHaveCount(0);
});

test('renders a generic file with one attachment card', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles('e2e/fixtures/report.txt');
  await page.getByRole('button', { name: 'Send message' }).click();
  const message = page.locator('article[data-media-kind="file"]').last();
  await expect(message).toContainText('report.txt');

  const framing = await message.evaluate((article) => {
    const wrapper = article.querySelector<HTMLElement>(':scope > .media-attachment.media-file')!;
    const control = wrapper.querySelector<HTMLElement>(':scope > :is(button, a).media-file')!;
    return {
      wrapperBorder: getComputedStyle(wrapper).borderTopWidth,
      wrapperBackground: getComputedStyle(wrapper).backgroundColor,
      controlBorder: getComputedStyle(control).borderTopWidth,
    };
  });

  expect(framing).toEqual({
    wrapperBorder: '0px',
    wrapperBackground: 'rgba(0, 0, 0, 0)',
    controlBorder: '1px',
  });
});

test('renders a staged album as one group while its upload is pending', async ({ page }) => {
  await page.evaluate(() => window.__televechaFixture?.holdNextUpload());
  await page.locator('input[type="file"]').setInputFiles([imagePath, imagePath]);
  await page.getByRole('button', { name: 'Send message' }).click();

  const album = page.locator('.media-album').last();
  await expect(album).toBeVisible();
  await expect(album).toHaveAttribute('data-album-size', '2');
  await expect(album.locator('xpath=ancestor::article')).toHaveClass(/message-media-surface/u);
  await expect(album.locator('.media-album-item')).toHaveCount(2);
  await expect(album.getByRole('img', { name: 'outgoing-media.png' })).toHaveCount(2);
  await expect(album.locator('.media-album-item').nth(0).getByRole('status')).toContainText('50%');
  await expect(album.locator('.media-album-item').nth(1).getByRole('status')).toContainText('0%');
  await expect(album.locator('.media-attachment > .media-upload-status')).toHaveCount(2);

  await page.evaluate(() => window.__televechaFixture?.releaseUpload());
  await expect.poll(async () => (await fixtureStats(page))?.sendAlbum).toBe(1);
  await expect(album.getByRole('status')).toHaveCount(0);
});

test('shows a local image preview while a single upload is pending', async ({ page }) => {
  await page.evaluate(() => window.__televechaFixture?.holdNextUpload());
  await page.locator('input[type="file"]').setInputFiles(imagePath);
  await page.getByRole('button', { name: 'Send message' }).click();

  const pending = page.locator('article[data-media-kind="photo"]').last();
  await expect(pending.getByRole('img', { name: 'outgoing-media.png' })).toBeVisible();
  await expect(pending).toHaveClass(/message-media-surface/u);
  await expect(pending.locator('.media-attachment > .media-upload-status')).toContainText('25%');
  const contained = await pending.evaluate((element) => {
    const image = element.querySelector('img')!.getBoundingClientRect();
    const status = element.querySelector('.media-upload-status')!.getBoundingClientRect();
    return (
      status.left >= image.left &&
      status.right <= image.right &&
      status.top >= image.top &&
      status.bottom <= image.bottom
    );
  });
  expect(contained).toBe(true);
  await expect(pending.locator('.upload-progress')).toHaveCount(0);

  await page.evaluate(() => window.__televechaFixture?.releaseUpload());
  await expect.poll(async () => (await fixtureStats(page))?.sendFile).toBe(1);
  await expect(pending.locator('.media-upload-status')).toHaveCount(0);
});

for (const shape of ['landscape', 'portrait', 'album'] as const) {
  test(`preserves the ${shape} preview dimensions and local image through confirmation`, async ({
    page,
  }) => {
    const sizes =
      shape === 'album'
        ? [
            [600, 400],
            [400, 600],
          ]
        : shape === 'landscape'
          ? [[600, 400]]
          : [[400, 600]];
    const files = await page.evaluate(
      (sizes) =>
        sizes.map(([width, height], index) => {
          const canvas = document.createElement('canvas');
          canvas.width = width!;
          canvas.height = height!;
          const context = canvas.getContext('2d')!;
          context.fillStyle = index === 0 ? '#f4ac45' : '#3c9e9b';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#17212b';
          context.fillRect(20, 20, 80, 80);
          return { name: `handoff-${index}.png`, data: canvas.toDataURL().split(',')[1]! };
        }),
      sizes,
    );
    await page.evaluate(() => window.__televechaFixture?.holdNextUpload());
    await page
      .locator('input[type="file"]')
      .setInputFiles(
        files.map(({ name, data }) => ({
          name,
          mimeType: 'image/png',
          buffer: Buffer.from(data, 'base64'),
        })),
      );
    await page.getByRole('textbox', { name: 'Message' }).fill('Image handoff');
    await page.getByRole('button', { name: 'Send message' }).click();
    const message = page.locator('article').filter({ hasText: 'Image handoff' });
    await expect(message.locator('.media-upload-status')).toHaveCount(files.length);
    const images = message.locator('.media-visual > img');
    await expect(images).toHaveCount(files.length);
    await expect
      .poll(() =>
        images.evaluateAll((elements) =>
          elements.every((element) => {
            const image = element as HTMLImageElement;
            return image.complete && image.naturalWidth > 0 && !image.hidden;
          }),
        ),
      )
      .toBe(true);
    const before = await images.evaluateAll((elements) =>
      elements.map((element) => {
        const image = element as HTMLImageElement;
        const { width, height } = image.getBoundingClientRect();
        return { src: image.src, width, height };
      }),
    );
    if (shape !== 'album') {
      expect(before[0]!.width / before[0]!.height).toBeCloseTo(sizes[0]![0]! / sizes[0]![1]!, 2);
    }

    const transition = await page.evaluate(async (before) => {
      let frames = 0;
      let settledFrames = 0;
      const problems: string[] = [];
      window.__televechaFixture?.releaseUpload();
      return await new Promise<{ frames: number; problems: string[] }>((resolve) => {
        const inspect = () => {
          frames += 1;
          before.forEach((expected, index) => {
            const image = document.querySelector<HTMLImageElement>(
              `article img[alt="handoff-${index}.png"]`,
            );
            if (!image || image.hidden || !image.complete || !image.naturalWidth) {
              problems.push(`frame ${frames}: image ${index} missing`);
              return;
            }
            const { width, height } = image.getBoundingClientRect();
            if (image.src !== expected.src)
              problems.push(`frame ${frames}: image ${index} replaced`);
            if (Math.abs(width - expected.width) > 1 || Math.abs(height - expected.height) > 1) {
              problems.push(`frame ${frames}: image ${index} resized to ${width}x${height}`);
            }
            if (image.closest('.media-attachment')?.querySelector('.media-loading:not([hidden])')) {
              problems.push(`frame ${frames}: image ${index} loading`);
            }
          });
          const pending = [...(window.__televechaRuntimes?.values() ?? [])][0]?.engine.snapshot()
            .pending;
          if (pending?.length === 0) settledFrames += 1;
          if (settledFrames >= 20 || frames >= 300) {
            if (settledFrames === 0) problems.push('Upload never confirmed');
            resolve({ frames, problems });
          } else requestAnimationFrame(inspect);
        };
        requestAnimationFrame(inspect);
      });
    }, before);
    expect(transition.problems).toEqual([]);
    expect(transition.frames).toBeGreaterThanOrEqual(20);
    await expect(message.locator('.media-upload-status')).toHaveCount(0);
    expect(
      (await fixtureStats(page))?.downloadMediaRequests.filter(({ name }) =>
        name?.startsWith('handoff-'),
      ),
    ).toEqual([]);

    await page.reload();
    await expect(message).toBeVisible();
    await expect
      .poll(() =>
        images.evaluateAll(
          (elements, count) =>
            elements.length === count &&
            elements.every((element) => {
              const image = element as HTMLImageElement;
              return image.complete && image.naturalWidth > 0 && !image.hidden;
            }),
          files.length,
        ),
      )
      .toBe(true);
    expect(
      await images.evaluateAll((elements) =>
        elements.map((element) => {
          const image = element as HTMLImageElement;
          return [image.naturalWidth, image.naturalHeight];
        }),
      ),
    ).toEqual(sizes);
    expect(
      (await fixtureStats(page))?.downloadMediaRequests.filter(({ name }) =>
        name?.startsWith('handoff-'),
      ),
    ).toEqual([]);
  });
}

test('crops and rotates a staged image before sending', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles(imagePath);
  const attachment = page.getByTestId('composer-attachment');
  await attachment.getByRole('button', { name: 'Edit image outgoing-media.png' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit image' });
  await editor.getByRole('button', { name: '16:9' }).click();
  await editor.getByRole('button', { name: 'Rotate right' }).click();
  await editor.getByRole('button', { name: 'Apply' }).click();

  await expect(editor).toHaveCount(0);
  await expect
    .poll(() =>
      attachment
        .locator('img')
        .evaluate((image: HTMLImageElement) =>
          Math.round((image.naturalWidth / image.naturalHeight) * 100),
        ),
    )
    .toBe(178);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(async () => (await fixtureStats(page))?.sendFile).toBe(1);
});

test('keeps a quarter-turned image fully inside the editor preview', async ({ page }) => {
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: wideImage as never });
  await page.getByRole('button', { name: 'Edit image wide.png' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit image' });
  await editor.getByRole('button', { name: 'Rotate right' }).click();

  const bounds = await editor.evaluate((element) => {
    const preview = element.querySelector<HTMLElement>('.image-editor-preview')!;
    const image = preview.querySelector('img')!;
    const bounds = (item: Element) => {
      const { left, top, right, bottom } = item.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    return { preview: bounds(preview), image: bounds(image) };
  });
  expect(bounds.image.left).toBeGreaterThanOrEqual(bounds.preview.left - 1);
  expect(bounds.image.top).toBeGreaterThanOrEqual(bounds.preview.top - 1);
  expect(bounds.image.right).toBeLessThanOrEqual(bounds.preview.right + 1);
  expect(bounds.image.bottom).toBeLessThanOrEqual(bounds.preview.bottom + 1);
});

test('keeps staged attachments with the chat they belong to', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles([imagePath, imagePath]);
  await expect(page.getByTestId('composer-attachment')).toHaveCount(2);

  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Release Channel/ })
    .click();
  await expect(page.getByTestId('composer-attachment')).toHaveCount(0);
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Alice Fixture/ })
    .click();

  await expect(page.getByTestId('composer-attachment')).toHaveCount(2);
  await expect(page.getByTestId('composer-attachment').first()).toContainText('outgoing-media.png');
});

test('replaces media while editing an outgoing message', async ({ page }) => {
  const message = page.locator('article[data-message-id="78"]');
  const originalSource = await message
    .getByRole('img', { name: 'fixture.jpg' })
    .getAttribute('src');
  await message.locator('.message-copy').click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Message actions' })
    .getByRole('menuitem', { name: 'Edit' })
    .click();
  await expect(page.getByTestId('composer-edit')).toContainText('Fixture message 78');
  await page.locator('input[type="file"]').setInputFiles(imagePath);
  await page.getByRole('textbox', { name: 'Message' }).fill('Replaced photo caption');

  await page.getByRole('button', { name: 'Send message' }).click();

  await expect.poll(async () => (await fixtureStats(page))?.editMessage).toBe(1);
  await expect(message).toContainText('Replaced photo caption');
  await expect(message.locator('.message-edited')).toHaveText('edited');
  await expect(message).toHaveClass(/message-captioned-media/u);
  const replacement = message.getByRole('img', { name: 'outgoing-media.png' });
  await expect(replacement).toBeVisible();
  await expect.poll(() => replacement.getAttribute('src')).not.toBe(originalSource);
  expect(
    (await fixtureStats(page))?.downloadMediaRequests.filter(
      ({ name }) => name === 'outgoing-media.png',
    ),
  ).toEqual([]);
});

test('does not overwrite a newer draft when a slow edit finishes', async ({ page }) => {
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Original saved draft');
  await page.evaluate(() => {
    window.__televechaFixture?.holdNextEdit();
  });

  const message = page.locator('article[data-message-id="78"]');
  await message.locator('.message-copy').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await composer.fill('Edited caption');
  await page.getByRole('button', { name: 'Send message' }).click();
  await composer.fill('Newer draft while edit saves');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__televechaRuntimes?.get('fixture:default')?.engine.snapshot().drafts['u:101'],
      ),
    )
    .toBe('Newer draft while edit saves');

  await page.evaluate(() => window.__televechaFixture?.releaseEdit());
  await expect(message).toContainText('Edited caption');
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Release Channel/ })
    .click();
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Alice Fixture/ })
    .click();
  await expect(composer).toHaveValue('Newer draft while edit saves');
});

test('keeps image-only corners free of the Telegram outgoing bubble background', async ({
  page,
}) => {
  await page.evaluate(() =>
    window.__televechaFixture!.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:999',
        text: '',
        date: Math.floor(Date.now() / 1000),
        outgoing: true,
        media: {
          kind: 'photo',
          name: 'corner.jpg',
          mimeType: 'image/jpeg',
          width: 400,
          height: 240,
        },
      },
    }),
  );
  const message = page.locator('article[data-message-id="81"]');
  await expect(message).toHaveClass(/message-media-surface/u);
  await expect(message.locator('img')).toBeVisible();
  await page.locator('.message-scroll-shell').evaluate((shell) => {
    shell.setAttribute('data-chat-theme', 'telegram');
    (shell as HTMLElement).style.setProperty('--chat-message-1', '#2dba77');
    (shell as HTMLElement).style.setProperty('--chat-message-2', '#2dba77');
  });
  await expect(message).toHaveCSS('background-image', 'none');
  await expect(message).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.message.outgoing:not(.message-media-surface)').first()).not.toHaveCSS(
    'background-image',
    'none',
  );
});
