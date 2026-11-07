import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';

test('adds poll answers while typing and keeps the correct quiz choice after empty rows', async ({
  page,
}) => {
  await openReady(page, '/?chat=g%3A303');
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await page
    .locator('.composer-attach-menu')
    .getByRole('button', { name: 'Poll', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'New Poll' });
  await expect(dialog.getByRole('textbox', { name: 'Question' })).toBeFocused();
  await dialog.getByRole('textbox', { name: 'Question' }).fill('Choose the correct option');
  await dialog.getByRole('textbox', { name: 'Answer 1', exact: true }).fill('Temporary');
  await dialog.getByRole('textbox', { name: 'Answer 2', exact: true }).fill('Correct');
  await dialog.getByRole('textbox', { name: 'Answer 2', exact: true }).press('Enter');
  await expect(dialog.getByRole('textbox', { name: 'Answer 3', exact: true })).toBeFocused();
  await dialog.getByRole('textbox', { name: 'Answer 3', exact: true }).fill('Wrong');
  await dialog.getByRole('checkbox', { name: 'Quiz mode' }).check();
  const quiz = page.getByRole('dialog', { name: 'New Quiz' });
  await quiz.getByRole('radio', { name: 'Answer 2 is correct', exact: true }).check();
  await quiz.getByRole('textbox', { name: 'Answer 1', exact: true }).fill('');
  await quiz.getByRole('button', { name: 'Create', exact: true }).click();
  const card = page.getByLabel('Quiz: Choose the correct option', { exact: true });
  await expect(card.locator('.poll-answer')).toHaveCount(2);
  await card.getByRole('button', { name: 'Wrong', exact: true }).click();
  await expect(card.locator('.is-correct')).toContainText('Correct');
  await expect(card.locator('.is-wrong')).toContainText('Wrong');
});
