import { expect, test } from '@playwright/test';
import { utimes } from 'node:fs/promises';

import { openReady } from './helpers';

test('does not reload the page when an unrelated project file changes', async ({ page }) => {
  await openReady(page);
  await page.evaluate(() => {
    (window as Window & { __hmrProbe?: string }).__hmrProbe = 'still-here';
  });

  const unrelatedFile = decodeURIComponent(new URL('./hmr-unrelated.md', import.meta.url).pathname);
  const now = new Date();
  await utimes(unrelatedFile, now, now);
  await page.waitForTimeout(500);

  await expect
    .poll(() => page.evaluate(() => (window as Window & { __hmrProbe?: string }).__hmrProbe))
    .toBe('still-here');
});
