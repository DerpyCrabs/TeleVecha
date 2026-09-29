import { expect, test } from '@playwright/test';
import { chatButton, openReady } from './helpers';

test('selects a member without a username, preserves the mention while typing, and sends it', async ({
  page,
}) => {
  await openReady(page);
  await chatButton(page, /Fixture Group/).click();
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Hi @ano');
  await expect(page.getByRole('option', { name: /Another Member/ })).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('Hi Another Member ');
  await expect(input).toBeFocused();
  await expect(page.getByRole('listbox', { name: 'Mention a member' })).toHaveCount(0);
  await input.pressSequentially('hello');
  await chatButton(page, /Alice Fixture/).click();
  await chatButton(page, /Fixture Group/).click();
  await expect(input).toHaveValue('Hi Another Member hello');
  await input.press('Enter');
  const message = page
    .getByTestId('message-scroller')
    .getByRole('link', { name: 'Another Member', exact: true })
    .last();
  await expect(message).toBeVisible();
  await expect(message).toHaveAttribute('href', 'tg://user?id=405');
  await expect(input).toHaveValue('');
  await input.fill('@');
  await expect(page.getByRole('option', { name: /Another Member/ })).toBeVisible();
});

test('supports mouse selection, Escape, caret boundaries, and chat switching', async ({ page }) => {
  await openReady(page);
  await chatButton(page, /Fixture Group/).click();
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('mail@example');
  await expect(page.getByRole('listbox', { name: 'Mention a member' })).toHaveCount(0);
  await input.fill('@');
  await expect(page.getByRole('option', { name: /Fixture Author/ })).toBeVisible();
  await input.press('ArrowDown');
  await input.dispatchEvent('select');
  await expect(page.getByRole('option', { name: /Another Member/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await input.press('Tab');
  await expect(input).toHaveValue('Another Member ');
  await input.fill('@');
  await expect(page.getByRole('option', { name: /Fixture Author/ })).toBeVisible();
  await input.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Mention a member' })).toHaveCount(0);
  await input.fill('@fi');
  await page.getByRole('option', { name: /Fixture Author/ }).click();
  await expect(input).toHaveValue('@fixture_author ');
  await chatButton(page, /Alice Fixture/).click();
  await input.fill('@');
  await expect(page.getByRole('listbox', { name: 'Mention a member' })).toHaveCount(0);
});
