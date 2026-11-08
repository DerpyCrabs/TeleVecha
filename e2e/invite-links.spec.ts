import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, chatButton } from './helpers';
for (const width of [1280, 375]) {
  test(`creates, edits and revokes invitation links at ${width}px`, async ({ page }, testInfo) => {
    await openReady(page);
    await page.setViewportSize({ width, height: 800 });
    if (width <= 650)
      await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
    await chatButton(page, /Fixture Group/).click();
    if (await page.getByRole('button', { name: 'Open details', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Open details', exact: true }).click();
    await page.getByRole('button', { name: 'Manage group', exact: true }).click();
    await page.getByRole('button', { name: 'Invitation links', exact: true }).click();
    const list = page.getByRole('dialog', { name: 'Invitation links', exact: true });
    await expect(list.getByRole('button', { name: /Primary link/ })).toBeVisible();
    await list.getByRole('button', { name: 'Create a new link', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'New invitation link', exact: true });
    await editor
      .getByRole('textbox', { name: 'Link name (optional)', exact: true })
      .fill('Weekend guests');
    await editor.getByRole('combobox', { name: 'Usage limit', exact: true }).selectOption('10');
    await editor.getByRole('combobox', { name: 'Time limit', exact: true }).selectOption('custom');
    await editor.getByLabel('Expiration date', { exact: true }).fill('2030-01-01T12:00');
    await page.screenshot({
      path: testInfo.outputPath(`invite-editor-${width}.png`),
      animations: 'disabled',
    });
    await editor.getByRole('button', { name: 'Create link', exact: true }).click();
    await expect(list.getByRole('textbox', { name: 'Invitation URL' })).toHaveValue(
      /https:\/\/t.me\/\+created_/,
    );
    await expect(list).toContainText('0 / 10');
    await list.getByRole('button', { name: 'Edit link', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit invitation link', exact: true });
    await edit.getByRole('switch', { name: /Request admin approval/ }).check();
    await expect(edit.getByRole('spinbutton')).toHaveCount(0);
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    const row = list.getByRole('button', { name: /Weekend guests/ });
    await expect(row).toContainText('Approval required');
    await row.click();
    await list.getByRole('button', { name: 'Revoke link', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Revoke invitation link?', exact: true });
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(list.getByRole('textbox', { name: 'Invitation URL' })).toBeVisible();
    await list.getByRole('button', { name: 'Revoke link', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Revoke link', exact: true }).click();
    await expect(row).toHaveCount(0);
    await list.getByRole('button', { name: 'Revoked', exact: true }).click();
    await row.click();
    await list.getByRole('button', { name: 'Delete link', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Delete invitation link?', exact: true })
      .getByRole('button', { name: 'Delete link', exact: true })
      .click();
    await expect(list).toContainText('No revoked links');
    await page.screenshot({
      path: testInfo.outputPath(`invite-links-${width}.png`),
      animations: 'disabled',
    });
  });
}
