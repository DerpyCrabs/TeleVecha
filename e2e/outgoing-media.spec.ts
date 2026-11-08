import { test } from '@playwright/test';
import { expect } from './expect';

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
  await page
    .locator('.chat-composer input[type="file"]')
    .setInputFiles([imagePath, imagePath, 'e2e/fixtures/report.txt']);
  const attachments = page.getByTestId('composer-attachment');
  await expect(attachments).toHaveCount(3);
  await expect(attachments.nth(2)).toContainText('report.txt');
  await page.getByRole('textbox', { name: 'Attachment caption' }).fill('Grouped upload caption');

  await page
    .locator('.attachment-send-dialog')
    .getByRole('button', { name: /^(Send|Save)$/ })
    .click();

  await expect.poll(async () => (await fixtureStats(page))?.sendAlbum).toBe(1);
  await expect.poll(async () => (await fixtureStats(page))?.sendFile).toBe(1);
  const album = page.locator('.media-album').last();
  await expect(album).toHaveAttribute('data-album-size', '2');
  await expect(album).toBeVisible();
  await expect(page.locator('article[data-media-kind="file"]').last()).toContainText('report.txt');
});

test('shows media in a send dialog and switches the batch to files', async ({ page }) => {
  await page
    .locator('.chat-composer input[type="file"]')
    .setInputFiles([imagePath, imagePath, imagePath, imagePath, imagePath]);
  const dialog = page.locator('.attachment-send-dialog');
  const attachments = dialog.getByTestId('composer-attachment');
  await expect(dialog).toHaveAccessibleName('Send 5 attachments');
  await expect(attachments).toHaveCount(5);
  await expect(dialog.getByRole('textbox', { name: 'Attachment caption' })).toBeFocused();
  await dialog.getByRole('checkbox', { name: 'Send as files' }).check();
  await expect(dialog.locator('.attachment-send-item.is-file')).toHaveCount(5);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(attachments).toHaveCount(0);
});

test('renders a generic file with one attachment card', async ({ page }) => {
  await page.locator('.chat-composer input[type="file"]').setInputFiles('e2e/fixtures/report.txt');
  await page
    .locator('.attachment-send-dialog')
    .getByRole('button', { name: /^(Send|Save)$/ })
    .click();
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
  await page.locator('.chat-composer input[type="file"]').setInputFiles([imagePath, imagePath]);
  await page
    .locator('.attachment-send-dialog')
    .getByRole('button', { name: /^(Send|Save)$/ })
    .click();

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
  await page.locator('.chat-composer input[type="file"]').setInputFiles(imagePath);
  await page
    .locator('.attachment-send-dialog')
    .getByRole('button', { name: /^(Send|Save)$/ })
    .click();

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
      .locator('.chat-composer input[type="file"]')
      .setInputFiles(
        files.map(({ name, data }) => ({
          name,
          mimeType: 'image/png',
          buffer: Buffer.from(data, 'base64'),
        })),
      );
    await page.getByRole('textbox', { name: 'Attachment caption' }).fill('Image handoff');
    await page
      .locator('.attachment-send-dialog')
      .getByRole('button', { name: /^(Send|Save)$/ })
      .click();
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
  await page.locator('.chat-composer input[type="file"]').setInputFiles(imagePath);
  const attachment = page.getByTestId('composer-attachment');
  await attachment.getByRole('button', { name: 'Edit image outgoing-media.png' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit image' });
  await editor.getByRole('combobox', { name: 'Crop aspect ratio' }).selectOption('16:9');
  await editor.getByRole('button', { name: 'Rotate right' }).click();
  await editor.getByRole('button', { name: 'Done' }).click();

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
  await page
    .locator('.attachment-send-dialog')
    .getByRole('button', { name: /^(Send|Save)$/ })
    .click();
  await expect.poll(async () => (await fixtureStats(page))?.sendFile).toBe(1);
});

test('keeps a quarter-turned image fully inside the editor preview', async ({ page }) => {
  await page
    .locator('.chat-composer input[type="file"]')
    .setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: wideImage as never });
  await page.getByRole('button', { name: 'Edit image wide.png' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit image' });
  await editor.getByRole('button', { name: 'Rotate right' }).click();

  const bounds = await editor.evaluate((element) => {
    const preview = element.querySelector<HTMLElement>('.image-editor-preview')!;
    const image = preview.querySelector('canvas')!;
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
  await page.locator('.chat-composer input[type="file"]').setInputFiles([imagePath, imagePath]);
  await expect(page.getByTestId('composer-attachment')).toHaveCount(2);

  for (const peerId of ['c:202', 'u:101']) {
    await page.evaluate((id) => {
      const url = new URL(location.href);
      url.searchParams.set('chat', id);
      history.pushState({}, '', url);
      dispatchEvent(new PopStateEvent('popstate'));
    }, peerId);
    await expect(page.getByTestId('composer-attachment')).toHaveCount(peerId === 'u:101' ? 2 : 0);
  }
  await expect(page.getByRole('button', { name: 'Edit image outgoing-media.png' })).toHaveCount(2);
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
  await page.locator('.chat-composer input[type="file"]').setInputFiles(imagePath);
  await page.getByRole('textbox', { name: 'Attachment caption' }).fill('Replaced photo caption');

  await page
    .locator('.attachment-send-dialog')
    .getByRole('button', { name: /^(Send|Save)$/ })
    .click();

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

for (const width of [1280, 375]) {
  test(`caption grows from one line and shrinks again at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.locator('.chat-composer input[type="file"]').setInputFiles(imagePath);
    const caption = page.getByRole('textbox', { name: 'Attachment caption' });
    await caption.fill('пора');
    const oneLine = (await caption.boundingBox())!.height;
    expect(oneLine).toBeLessThan(45);
    await page.screenshot({
      path: testInfo.outputPath(`caption-${width}.png`),
      animations: 'disabled',
    });
    await caption.fill('Первая строка\nВторая строка\nТретья строка');
    await expect
      .poll(async () => (await caption.boundingBox())!.height)
      .toBeGreaterThan(oneLine + 30);
    await caption.fill('пора');
    await expect.poll(async () => (await caption.boundingBox())!.height).toBe(oneLine);
    await page
      .locator('.attachment-send-dialog')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await page.evaluate(() => {
      ['Первое сообщение', 'Продолжение', 'Последнее в серии'].forEach((text, index) => {
        window.__televechaFixture!.emit({
          type: 'new-message',
          pts: 11 + index,
          ptsCount: 1,
          message: {
            id: 81 + index,
            peerId: 'u:101',
            senderId: 'self',
            outgoing: true,
            text,
            date: 1700002000 + index,
          },
        });
      });
    });
    const bubbles = page
      .locator('article.message.outgoing')
      .filter({ hasText: /Первое сообщение|Продолжение|Последнее в серии/ });
    await expect(bubbles).toHaveCount(3);
    await expect(bubbles.nth(0)).toHaveCSS('border-bottom-right-radius', '4px');
    await expect(bubbles.nth(1)).toHaveCSS('border-top-right-radius', '4px');
    await expect(bubbles.nth(2)).toHaveCSS('border-bottom-right-radius', '0px');
    await page.getByTestId('message-scroller').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.screenshot({
      path: testInfo.outputPath(`bubbles-${width}.png`),
      animations: 'disabled',
    });
  });
}
