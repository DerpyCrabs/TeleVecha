import { test, type Locator } from '@playwright/test';
import { expect } from './expect';
import { fixtureStats, openReady, selectAlice } from './helpers';

async function expectDecodedImages(images: Locator, count: number) {
  await expect(images).toHaveCount(count);
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
}

test.beforeEach(async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
});

for (const kind of ['image-file', 'video', 'video-album'] as const) {
  test(`reuses the ${kind} preview and original through upload, playback, and reload`, async ({
    page,
  }) => {
    const video = kind !== 'image-file';
    const path = video ? 'e2e/fixtures/outgoing-video.webm' : 'e2e/fixtures/outgoing-media.png';
    const name = path.split('/').at(-1)!;
    const count = kind === 'video-album' ? 2 : 1;
    await page.evaluate(() => window.__televechaFixture?.holdNextUpload());
    await page
      .locator('.chat-composer input[type="file"]')
      .setInputFiles(Array.from({ length: count }, () => path));
    if (video) {
      const previews = page.getByTestId('composer-attachment').locator('video');
      await expect(previews).toHaveCount(count);
      await expect(previews.first()).toBeVisible();
      await expect
        .poll(() =>
          previews.evaluateAll((elements) =>
            elements.every((element) => {
              const video = element as HTMLVideoElement;
              return (
                video.readyState >= 2 && video.videoWidth > 0 && video.paused && video.controls
              );
            }),
          ),
        )
        .toBe(true);
      const preview = previews.first();
      await preview.focus();
      await preview.press('Space');
      await expect
        .poll(() => preview.evaluate((video) => (video as HTMLVideoElement).currentTime))
        .toBeGreaterThan(0);
      await preview.press('Space');
      await expect
        .poll(() => preview.evaluate((video) => (video as HTMLVideoElement).paused))
        .toBe(true);
      const attachments = page.getByTestId('composer-attachment');
      await expect(
        attachments.first().getByRole('button', { name: /Remove attachment/ }),
      ).toBeVisible();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 800 });
        const geometry = await preview.evaluate((element) => {
          const { width, height, right } = element.getBoundingClientRect();
          return { width, height, right, viewport: window.innerWidth };
        });
        expect(geometry.width).toBeGreaterThan(140);
        expect(geometry.height).toBeGreaterThanOrEqual(100);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
      }
      await page.setViewportSize({ width: 1280, height: 720 });
      expect((await fixtureStats(page))?.sendFile).toBe(0);
    }
    if (!video) await page.getByRole('checkbox', { name: 'Send as files' }).check();
    await page.getByRole('textbox', { name: 'Attachment caption' }).fill(`Cached ${kind}`);
    const send = page
      .locator('.attachment-send-dialog')
      .getByRole('button', { name: /^(Send|Save)$/ });
    await send.focus();
    await page.mouse.move(0, 0);
    await send.press('Enter');
    const message = page.locator('article').filter({ hasText: `Cached ${kind}` });
    await expect(message.locator('.media-upload-status')).toHaveCount(count);
    const images = message.locator(video ? '.media-visual > img' : '.media-file-thumbnail img');
    await expectDecodedImages(images, count);
    const before = await images.evaluateAll((elements) =>
      elements.map((element) => {
        const image = element as HTMLImageElement;
        const { width, height } = image.getBoundingClientRect();
        return { src: image.src, width, height, ratio: image.naturalWidth / image.naturalHeight };
      }),
    );
    if (video) {
      expect(before.every(({ ratio }) => Math.abs(ratio - 1.5) < 0.01)).toBe(true);
      if (count === 1) expect(before[0]!.width / before[0]!.height).toBeCloseTo(1.5, 2);
    }
    const problems = await message.evaluate(async (element, before) => {
      const problems: string[] = [];
      const caption = element.textContent!.includes('Cached video-album')
        ? 'Cached video-album'
        : element.textContent!.includes('Cached video')
          ? 'Cached video'
          : 'Cached image-file';
      window.__televechaFixture?.releaseUpload();
      let frames = 0;
      let settled = 0;
      return await new Promise<string[]>((resolve) => {
        const inspect = () => {
          frames++;
          const message = [...document.querySelectorAll('article')].find((article) =>
            article.textContent?.includes(caption),
          );
          const images = message?.querySelectorAll<HTMLImageElement>(
            '.media-visual > img, .media-file-thumbnail img',
          );
          if (images?.length !== before.length) problems.push(`frame ${frames}: missing images`);
          images?.forEach((image, index) => {
            const previous = before[index]!;
            const { width, height } = image.getBoundingClientRect();
            if (!image.complete || !image.naturalWidth || image.hidden)
              problems.push(`frame ${frames}: undecoded image`);
            if (image.src !== previous.src)
              problems.push(`frame ${frames}: changed preview source`);
            if (Math.abs(width - previous.width) > 1 || Math.abs(height - previous.height) > 1)
              problems.push(`frame ${frames}: resized preview`);
          });
          if (!message?.querySelector('.media-upload-status')) settled++;
          if (settled >= 20 || frames >= 300) {
            if (!settled) problems.push('Upload never confirmed');
            resolve(problems);
          } else requestAnimationFrame(inspect);
        };
        requestAnimationFrame(inspect);
      });
    }, before);
    expect(problems).toEqual([]);
    const requests = async () =>
      (await fixtureStats(page))?.downloadMediaRequests.filter((request) => request.name === name);
    expect(await requests()).toEqual([]);
    if (video) {
      await message.locator('.media-visual').first().hover();
      const playback = message.locator('video').first();
      await expect(playback).toBeVisible();
      await expect
        .poll(() => playback.evaluate((video: HTMLVideoElement) => video.videoWidth))
        .toBe(600);
      await expect
        .poll(() => playback.evaluate((video: HTMLVideoElement) => !video.paused))
        .toBe(true);
    } else {
      await message.getByRole('button', { name: `Open ${name} fullscreen preview` }).click();
      await expectDecodedImages(
        page.getByRole('dialog', { name: `Media preview: ${name}` }).locator('img'),
        1,
      );
    }
    expect(await requests()).toEqual([]);
    await page.reload();
    await expect(message).toBeVisible();
    await expectDecodedImages(images, count);
    if (video) {
      await message.locator('.media-visual').first().hover();
      await expect
        .poll(() =>
          message
            .locator('video')
            .first()
            .evaluate((video: HTMLVideoElement) => video.videoWidth),
        )
        .toBe(600);
    }
    expect(await requests()).toEqual([]);
  });
}

test('keeps a replacement image visible and cached without downloading it again', async ({
  page,
}) => {
  const message = page.locator('article[data-message-id="78"]');
  await expectDecodedImages(message.locator('.media-visual > img'), 1);
  await message.locator('.message-copy').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page
    .locator('.chat-composer input[type="file"]')
    .setInputFiles('e2e/fixtures/outgoing-media.png');
  await page.getByRole('textbox', { name: 'Attachment caption' }).fill('Cached replacement');
  await page.evaluate(() => window.__televechaFixture?.holdNextEdit());
  await page
    .locator('.attachment-send-dialog')
    .getByRole('button', { name: /^(Send|Save)$/ })
    .click();
  await expect.poll(async () => (await fixtureStats(page))?.editMessage).toBe(1);
  const blankFrames = await message.evaluate(async (element) => {
    let blankFrames = 0;
    let frames = 0;
    window.__televechaFixture?.releaseEdit();
    return await new Promise<number>((resolve) => {
      const inspect = () => {
        const image = element.querySelector<HTMLImageElement>('.media-visual > img');
        if (!image || image.hidden || !image.complete || !image.naturalWidth) blankFrames++;
        if (++frames === 30) resolve(blankFrames);
        else requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    });
  });
  expect(blankFrames).toBe(0);
  await expect(message).toContainText('Cached replacement');
  await expectDecodedImages(message.getByRole('img', { name: 'outgoing-media.png' }), 1);
  const requests = async () =>
    (await fixtureStats(page))?.downloadMediaRequests.filter(
      ({ name }) => name === 'outgoing-media.png',
    );
  expect(await requests()).toEqual([]);
  await page.reload();
  await expectDecodedImages(message.getByRole('img', { name: 'outgoing-media.png' }), 1);
  expect(await requests()).toEqual([]);
});
