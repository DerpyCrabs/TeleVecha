import { test } from '@playwright/test';
import { expect } from './expect';

import { openReady } from './helpers';

test('serves the TeleVecha browser identity', async ({ page, request }) => {
  await openReady(page);

  await expect(page).toHaveTitle('Release Channel - TeleVecha');
  await expect(page.locator('meta[name="application-name"]')).toHaveAttribute(
    'content',
    'TeleVecha',
  );

  const href = await page.locator('link[rel="icon"]').getAttribute('href');
  expect(decodeURIComponent(href ?? '')).toMatch(/<text[^>]*>4<\/text>/u);

  const response = await request.get('/favicon.svg');
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
