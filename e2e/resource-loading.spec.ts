import { expect, test } from '@playwright/test';

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

test('serves the TeleVecha browser identity', async ({ page, request }) => {
  await openReady(page);

  await expect(page).toHaveTitle('Release Channel - TeleVecha');
  await expect(page.locator('meta[name="application-name"]')).toHaveAttribute(
    'content',
    'TeleVecha',
  );

  const href = await page.locator('link[rel="icon"]').getAttribute('href');
  expect(href).toBe('/favicon.svg');

  const response = await request.get(href!);
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('image/svg+xml');
  expect(await response.text()).toContain('<title>TeleVecha</title>');

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).toBe('/site.webmanifest');

  const manifestResponse = await request.get(manifestHref!);
  expect(manifestResponse.ok()).toBe(true);
  expect(await manifestResponse.json()).toMatchObject({
    name: 'TeleVecha',
    short_name: 'TeleVecha',
  });
});
