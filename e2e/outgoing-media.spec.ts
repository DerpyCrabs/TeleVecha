import { expect, test } from '@playwright/test';

import { fixtureStats, openReady, selectAlice } from './helpers';

const imagePath = 'e2e/fixtures/outgoing-media.png';
const wideImage = (
  globalThis as unknown as {
    Buffer: { from(value: string, encoding: 'base64'): Uint8Array };
  }
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

test('renders a staged album as one group while its upload is pending', async ({ page }) => {
  await page.goto('/?scenario=held-upload');
  await selectAlice(page);
  await page.locator('input[type="file"]').setInputFiles([imagePath, imagePath]);
  await page.getByRole('button', { name: 'Send message' }).click();

  const album = page.locator('.media-album').last();
  await expect(album).toBeVisible();
  await expect(album).toHaveAttribute('data-album-size', '2');
  await expect(album.locator('xpath=ancestor::article')).not.toHaveClass(/message-media-surface/u);
  await expect(album.locator('.media-album-item')).toHaveCount(2);
  await expect(album.getByRole('img', { name: 'outgoing-media.png' })).toHaveCount(2);
  await expect(album.getByRole('status').filter({ hasText: '25%' })).toHaveCount(2);

  await page.evaluate(() => window.__televechaFixture?.releaseUpload());
  await expect.poll(async () => (await fixtureStats(page))?.sendAlbum).toBe(1);
});

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
  await page.locator('input[type="file"]').setInputFiles({
    name: 'wide.png',
    mimeType: 'image/png',
    buffer: wideImage as never,
  });
  await page.getByRole('button', { name: 'Edit image wide.png' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit image' });
  await editor.getByRole('button', { name: 'Rotate right' }).click();

  const bounds = await editor.evaluate((element) => {
    const preview = element.querySelector<HTMLElement>('.image-editor-preview')!;
    const image = preview.querySelector('img')!;
    return {
      preview: preview.getBoundingClientRect().toJSON(),
      image: image.getBoundingClientRect().toJSON(),
    };
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
  const downloadsBefore = (await fixtureStats(page))?.downloadMedia ?? 0;
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
  await expect
    .poll(async () => (await fixtureStats(page))?.downloadMedia ?? 0)
    .toBeGreaterThan(downloadsBefore);
});

test('does not overwrite a newer draft when a slow edit finishes', async ({ page }) => {
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Original saved draft');
  await page.evaluate(() => {
    const transport = window.__televechaRuntimes?.get('fixture:default')?.transport;
    if (!transport) throw new Error('Fixture transport is unavailable');
    const original = transport.editMessage.bind(transport);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    window.__releaseFixtureEdit = release;
    transport.editMessage = async (peer, messageId, text, formats, replacement) => {
      await held;
      return original(peer, messageId, text, formats, replacement);
    };
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

  await page.evaluate(() => window.__releaseFixtureEdit?.());
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
