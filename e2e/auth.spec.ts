import { expect, test } from '@playwright/test';

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
