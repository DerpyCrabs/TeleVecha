import { expect, test } from '@playwright/test';

for (const kind of ['success', 'failure', 'defect', 'throw'] as const) {
  test(`authentication becomes usable again after ${kind}`, async ({ page }) => {
    await page.goto('/e2e/fixtures/index.html');
    await page.evaluate(async (kind) => {
      const path = '/src/ui/testing/commandFixture.ts';
      const { mountAuthCommandFixture } = (await import(
        path
      )) as typeof import('../src/ui/testing/commandFixture');
      mountAuthCommandFixture(document.body, kind);
    }, kind);
    await page.getByPlaceholder('+7 999 123 45 67').fill('+79991234567');
    const submit = page.getByRole('button', { name: 'Request code' });
    await submit.click();
    await expect(submit).toBeEnabled();
    await expect(page.locator('body')).toHaveAttribute('data-auth-attempts', '1');
    await submit.click();
    await expect(submit).toBeEnabled();
    await expect(page.locator('body')).toHaveAttribute('data-auth-attempts', '2');
  });
}

for (const kind of ['failure', 'defect', 'throw'] as const) {
  test(`media stream clears loading and allows retry after ${kind}`, async ({ page }) => {
    await page.goto('/e2e/fixtures/index.html');
    await page.evaluate(async (kind) => {
      const path = '/src/ui/testing/commandFixture.ts';
      const { mountMediaCommandFixture } = (await import(
        path
      )) as typeof import('../src/ui/testing/commandFixture');
      mountMediaCommandFixture(document.body, kind);
    }, kind);
    const retry = page.getByRole('button', { name: 'Retry loading audit.png' });
    await expect(retry).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-media-attempts', '1');
    await retry.click();
    await expect(retry).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-media-attempts', '2');
  });
}

test('the real GIF retry button runs its cold Effect on every accepted click', async ({ page }) => {
  await page.goto('/e2e/fixtures/index.html');
  await page.evaluate(async () => {
    const path = '/src/ui/testing/commandFixture.ts';
    const { mountGifRetryFixture } = (await import(
      path
    )) as typeof import('../src/ui/testing/commandFixture');
    mountGifRetryFixture(document.body);
  });
  const retry = page.getByRole('button', { name: 'Retry GIFs' });
  await retry.click();
  await expect(page.locator('body')).toHaveAttribute('data-gif-attempts', '1');
  await retry.click();
  await expect(page.locator('body')).toHaveAttribute('data-gif-attempts', '2');
});
