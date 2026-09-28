import { expect, test } from '@playwright/test';

test('video plays buffered bytes and opens autoplay fullscreen while the rest is held', async ({
  page,
}) => {
  await page.goto('/e2e/fixtures/index.html');
  await page.evaluate(async () => {
    const path = '/src/ui/testing/mediaLifetimeFixture.ts';
    const { mountStreamingVideoFixture } = (await import(
      path
    )) as typeof import('../src/ui/testing/mediaLifetimeFixture');
    const fixture = await mountStreamingVideoFixture(document.body);
    Object.assign(window, { streamingFixture: fixture });
  });
  const attachment = page.getByRole('button', {
    name: 'Open streaming-video.mp4 fullscreen preview',
  });
  await attachment.hover();
  const inline = page.locator('.media-visual video');
  await expect
    .poll(() => inline.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(0);
  await attachment.click();
  const viewer = page.getByRole('dialog', { name: 'Media preview: streaming-video.mp4' });
  await expect(viewer).toBeVisible();
  const video = viewer.locator('video');
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0);
  const beforeRelease = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        streamingFixture: { fullDownloads(): number; requests: { start: number }[] };
      }
    ).streamingFixture;
    return {
      downloads: fixture.fullDownloads(),
      requestedRemainder: fixture.requests.some(({ start }) => start >= 256 * 1024),
    };
  });
  expect(beforeRelease).toEqual({ downloads: 0, requestedRemainder: true });
  // A user pause survives ordinary rerenders.
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await page.waitForTimeout(100);
  expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await page.evaluate(() =>
    (window as unknown as { streamingFixture: { release(): void } }).streamingFixture.release(),
  );
  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = 25;
    return element.play();
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(25);
  await page.getByRole('button', { name: 'Close media preview' }).click();
  await expect(viewer).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { streamingFixture: { close(): Promise<void> } }
    ).streamingFixture.close(),
  );
});

test('media URL supports bounded, suffix and invalid byte ranges', async ({ page }) => {
  await page.goto('/e2e/fixtures/index.html');
  const result = await page.evaluate(async () => {
    const path = '/src/ui/testing/mediaLifetimeFixture.ts';
    const { mountStreamingVideoFixture } = (await import(
      path
    )) as typeof import('../src/ui/testing/mediaLifetimeFixture');
    const fixture = await mountStreamingVideoFixture(document.body);
    fixture.release();
    const original = await (await fetch('/e2e/fixtures/streaming-video.mp4')).arrayBuffer();
    const check = async (range: string, start: number, end: number) => {
      const response = await fetch(fixture.url, { headers: { Range: range } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return (
        response.status === 206 &&
        response.headers.get('Content-Range') === `bytes ${start}-${end}/${original.byteLength}` &&
        bytes.every((value, index) => value === new Uint8Array(original)[start + index]) &&
        bytes.length === end - start + 1
      );
    };
    const bounded = await check('bytes=123-999', 123, 999);
    const suffix = await check('bytes=-31', original.byteLength - 31, original.byteLength - 1);
    const invalid = await fetch(fixture.url, {
      headers: { Range: `bytes=${original.byteLength}-` },
    });
    const calls = fixture.requests.length;
    const repeated = await check('bytes=123-999', 123, 999);
    const reused = fixture.requests.length === calls;
    await fixture.close();
    return { bounded, suffix, invalid: invalid.status, repeated, reused };
  });
  expect(result).toEqual({
    bounded: true,
    suffix: true,
    invalid: 416,
    repeated: true,
    reused: true,
  });
});
