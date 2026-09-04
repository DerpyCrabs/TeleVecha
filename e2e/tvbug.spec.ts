import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

import { openReady, selectAlice } from './helpers';

const execFileAsync = promisify(execFile);

test('exports a compact account-free snapshot and inspects it without Telegram', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openReady(page);
  await selectAlice(page);

  const source = page.locator('article[data-message-id="79"]');
  await source.getByRole('button', { name: 'Reply to message 79' }).click();
  const reportReplyText = 'First report line\nSecond report line';
  await page.getByRole('textbox', { name: 'Message' }).fill(reportReplyText);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('article[data-message-id="81"]')).toContainText('First report line');

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

  const archiveBytes = await readFile(downloadPath);
  expect(archiveBytes.byteLength).toBeLessThan(1024 * 1024);
  const archive = unzipSync(archiveBytes);
  const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as Record<string, unknown>;
  const state = JSON.parse(strFromU8(archive['snapshot.v2.json']!)) as Record<string, unknown>;
  const trace = strFromU8(archive['trace.v2.ndjson']!)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const bundle = { manifest, snapshot: state, trace };
  const serialized = JSON.stringify(bundle);

  expect(serialized).not.toContain('Alice Fixture');
  expect(serialized).not.toContain('Newest message from fixture');
  expect(serialized).not.toContain(reportReplyText);
  expect(serialized).not.toContain('u:101');
  expect(serialized).not.toContain('"year":1994');
  expect(serialized).toContain('"senderColor":"#408acf"');
  expect(serialized).toContain('"width":320');
  expect(serialized).toContain('"height":180');
  expect(serialized).toContain('"byteSize":42000');
  expect(serialized).toContain(
    `"textMetrics":{"utf16Length":${'Newest message from fixture'.length}`,
  );
  expect(trace.some((event) => event.kind === 'call')).toBe(false);
  expect(trace.some((event) => event.kind === 'ui' && event.method === 'composer-reply')).toBe(
    true,
  );
  expect(trace.some((event) => event.kind === 'ui' && event.method === 'composer-send')).toBe(true);
  expect(trace.some((event) => event.kind === 'ui' && event.method === 'composer-focus')).toBe(
    true,
  );
  expect(
    trace.some((event) => event.kind === 'ui' && event.method === 'conversation-viewport'),
  ).toBe(true);
  expect((state.ui as { bootstrapActivePeerId?: string } | undefined)?.bootstrapActivePeerId).toBe(
    'c:1',
  );
  expect((state.workspace as { activePeerId?: string }).activePeerId).toBe('u:1');

  const inspector = await page.context().newPage();
  await inspector.addInitScript((injected) => {
    window.__televechaTvBugBundle = injected as unknown as NonNullable<
      typeof window.__televechaTvBugBundle
    >;
  }, bundle);
  await inspector.goto('/');
  await expect
    .poll(() => inspector.evaluate(() => window.__televechaTvBugStatus?.state))
    .toBe('ready');
  const inspectionStatus = await inspector.evaluate(() => window.__televechaTvBugStatus);
  if (inspectionStatus?.state !== 'ready') {
    throw new Error(`Snapshot did not become ready: ${JSON.stringify(inspectionStatus)}`);
  }
  await expect(inspector.getByTestId('message-scroller')).toBeVisible();

  const inspectedReply = inspector.locator('article[data-message-id="81"]');
  await expect(inspectedReply).toBeVisible();
  await expect(inspectedReply.locator('.message-body')).toHaveText(
    new RegExp(`^[\\s\\S]{${reportReplyText.length}}$`, 'u'),
  );
  await expect(inspectedReply.getByRole('button', { name: /Jump/ })).toBeVisible();

  const generatedText = await inspector
    .locator('article[data-message-id="80"] .message-body')
    .textContent();
  expect(generatedText).not.toBe('Newest message from fixture');
  expect(generatedText).toHaveLength('Newest message from fixture'.length);
  const inspectedPhoto = await inspector.locator('article[data-message-id="78"]').boundingBox();
  expect(inspectedPhoto).not.toBeNull();
  expect(inspectedPhoto!.width).toBeCloseTo(capturedPhoto!.width, 1);
  expect(inspectedPhoto!.height).toBeCloseTo(capturedPhoto!.height, 1);

  const { stdout } = await execFileAsync(
    process.execPath,
    ['scripts/inspect-tvbug.mjs', '--headless', downloadPath],
    {
      cwd: process.cwd(),
      env: { ...process.env, TELEVECHA_TVBUG_PORT: '42875' },
      timeout: 30_000,
    },
  );
  expect(stdout).toContain('Snapshot status: ready.');
});
