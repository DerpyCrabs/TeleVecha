import { expect, test } from '@playwright/test';

import { fixtureStats, openReady } from './helpers';

test('signs in an existing account with phone and code', async ({ page }) => {
  await page.goto('/?scenario=auth');
  await expect(page.getByRole('heading', { name: 'Your phone number' })).toBeVisible();
  const request = page.getByRole('button', { name: 'Request code' });
  await expect(request).toBeDisabled();
  await page.getByRole('textbox', { name: 'Phone' }).fill('+79991234567');
  await request.click();

  await expect(page.getByRole('heading', { name: 'Enter the login code' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Code' }).fill('12345');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('chat-list')).toBeVisible();
});

test('handles two-step verification and allows retry after a wrong password', async ({ page }) => {
  await page.goto('/?scenario=auth');
  await page.getByRole('textbox', { name: 'Phone' }).fill('+79991234567');
  await page.getByRole('button', { name: 'Request code' }).click();
  await page.getByRole('textbox', { name: 'Code' }).fill('22222');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(
    page.getByText(/Telegram rejected the two-step verification password/),
  ).toBeVisible();
  await page.getByLabel('Password').fill('correct');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('keeps the phone form usable after Telegram rejects a number', async ({ page }) => {
  await page.goto('/?scenario=auth');
  await page.getByRole('textbox', { name: 'Phone' }).fill('+7000');
  await page.getByRole('button', { name: 'Request code' }).click();
  await expect(page.getByText(/Telegram could not send a login code/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request code' })).toBeEnabled();
});

test('reports rejected codes and unsupported sign-up without leaving the code form', async ({
  page,
}) => {
  await page.goto('/?scenario=auth');
  await page.getByRole('textbox', { name: 'Phone' }).fill('+79991234567');
  await page.getByRole('button', { name: 'Request code' }).click();
  const code = page.getByRole('textbox', { name: 'Code' });

  await code.fill('00000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/Telegram rejected the login code/)).toBeVisible();
  await code.fill('99999');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('TeleVecha signs in existing accounts only.')).toBeVisible();
  await expect(code).toBeVisible();
});

test('shows a useful connection failure and retries without a fake close button', async ({
  page,
}) => {
  await page.goto('/?scenario=connect-fails-once');
  await expect(page.getByRole('heading', { name: 'Connection failed' })).toBeVisible();
  await expect(page.getByText(/Fixture connection failure/)).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Close' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('chat-list')).toBeVisible();
});

test('signs out, clears local account data, and returns to phone authentication', async ({
  page,
}) => {
  await openReady(page);
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Sign out' }).click();

  await expect(page.getByRole('heading', { name: 'Your phone number' })).toBeVisible();
  await expect(page.getByTestId('chat-list').locator('.chat-row')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open('televecha-e2e');
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const stores = ['dialogs', 'messages', 'drafts', 'outbox', 'files'];
        const transaction = database.transaction(stores);
        return Promise.all(
          stores.map(
            (name) =>
              new Promise<number>((resolve, reject) => {
                const count = transaction.objectStore(name).count();
                count.onsuccess = () => resolve(count.result);
                count.onerror = () => reject(count.error);
              }),
          ),
        );
      }),
    )
    .toEqual([0, 0, 0, 0, 0]);
});

test('clears local cache and reconnects without signing out', async ({ page }) => {
  await openReady(page);
  const connectsBefore = (await fixtureStats(page))?.connect ?? 0;
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Clear cache' })
    .click();

  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await expect
    .poll(async () => (await fixtureStats(page))?.connect ?? 0)
    .toBeGreaterThan(connectsBefore);
  await expect(page.getByTestId('chat-list')).toContainText('Alice Fixture');
  await expect(page.getByRole('heading', { name: 'Your phone number' })).toHaveCount(0);
});
