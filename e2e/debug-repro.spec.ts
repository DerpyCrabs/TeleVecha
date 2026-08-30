import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

import { openReady, selectAlice } from './helpers';

const execFileAsync = promisify(execFile);

test('exports account-free rendering data and replays it without Telegram', async ({ page }) => {
  test.setTimeout(60_000);
  await openReady(page);
  await selectAlice(page);

  const capturedPhoto = await page.locator('article[data-message-id="78"]').boundingBox();
  expect(capturedPhoto).not.toBeNull();
  await page.getByRole('button', { name: 'Open settings' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Download report' })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^televecha-\d{8}-[a-f0-9]+\.tvbug$/u);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('Playwright did not retain the debug report download.');

  const archive = unzipSync(await readFile(downloadPath));
  const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as Record<string, unknown>;
  const state = JSON.parse(strFromU8(archive['state.v1.json']!)) as Record<string, unknown>;
  const timeline = strFromU8(archive['timeline.v1.ndjson']!)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const bundle = { manifest, state, timeline };
  const serialized = JSON.stringify(bundle);

  expect(serialized).not.toContain('Alice Fixture');
  expect(serialized).not.toContain('Newest message from fixture');
  expect(serialized).not.toContain('u:101');
  expect(serialized).not.toContain('"year":1994');
  expect(serialized).toContain('"senderColor":"#408acf"');
  expect(serialized).toContain('"width":320');
  expect(serialized).toContain('"height":180');
  expect(serialized).toContain('"size":42000');
  expect(serialized).toContain(
    `"textMetrics":{"utf16Length":${'Newest message from fixture'.length}`,
  );
  expect(timeline.some((event) => event.kind === 'call')).toBe(true);
  expect(state.lastPeerId).toBeUndefined();

  const replay = await page.context().newPage();
  await replay.addInitScript((injected) => {
    window.__televechaReproBundle = injected as unknown as NonNullable<
      typeof window.__televechaReproBundle
    >;
  }, bundle);
  await replay.goto('/');
  await expect
    .poll(() => replay.evaluate(() => window.__televechaReproStatus?.state))
    .not.toBe('loading');
  const replayStatus = await replay.evaluate(() => window.__televechaReproStatus);
  if (replayStatus?.state !== 'ready') {
    throw new Error(`Replay did not become ready: ${JSON.stringify(replayStatus)}`);
  }
  await expect(replay.getByTestId('message-scroller')).toBeVisible();

  const generatedText = await replay
    .locator('article[data-message-id="80"] .message-body')
    .textContent();
  expect(generatedText).not.toBe('Newest message from fixture');
  expect(generatedText).toHaveLength('Newest message from fixture'.length);
  const replayedPhoto = await replay.locator('article[data-message-id="78"]').boundingBox();
  expect(replayedPhoto).not.toBeNull();
  expect(replayedPhoto!.width).toBeCloseTo(capturedPhoto!.width, 1);
  expect(replayedPhoto!.height).toBeCloseTo(capturedPhoto!.height, 1);

  const lastEvent = timeline.at(-1);
  const incompleteBundle = {
    manifest,
    state,
    timeline: [
      ...timeline,
      {
        seq: Number(lastEvent?.seq ?? 0) + 1,
        tMs: Number(lastEvent?.tMs ?? 0),
        kind: 'call',
        callId: 'unclaimed:1',
        method: 'searchGifs',
        args: [],
      },
    ],
  };
  const incompleteReplay = await page.context().newPage();
  await incompleteReplay.addInitScript((injected) => {
    window.__televechaReproBundle = injected as unknown as NonNullable<
      typeof window.__televechaReproBundle
    >;
  }, incompleteBundle);
  await incompleteReplay.goto('/');
  await expect
    .poll(() => incompleteReplay.evaluate(() => window.__televechaReproStatus?.state), {
      timeout: 5_000,
    })
    .toBe('diverged');
  await expect
    .poll(() => incompleteReplay.evaluate(() => window.__televechaReproStatus?.message))
    .toContain('before consuming the recorded transport timeline');
  await incompleteReplay.close();

  const { stdout } = await execFileAsync(
    process.execPath,
    ['scripts/replay-tvbug.mjs', '--headless', downloadPath],
    {
      cwd: process.cwd(),
      env: { ...process.env, TELEVECHA_REPLAY_PORT: '42875' },
      timeout: 30_000,
    },
  );
  expect(stdout).toContain('Replay status: ready.');
});
