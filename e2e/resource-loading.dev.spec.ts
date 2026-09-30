import { test } from '@playwright/test';
import { expect } from './expect';

import { openReady } from './helpers';

test('loads only the Lucide icons used by the interface', async ({ page }) => {
  await openReady(page);

  const iconResources = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter(
        (name) =>
          name.includes('/@effectweb_lucide_icons_') ||
          name.includes('/@effectweb/lucide/dist/icons/') ||
          name.includes('/EffectWeb/packages/lucide/dist/icons/'),
      ),
  );

  expect(iconResources).not.toEqual(expect.arrayContaining([expect.stringContaining('ambulance')]));
  expect(iconResources.length).toBeGreaterThan(0);
  expect(iconResources.length).toBeLessThanOrEqual(66);
});
