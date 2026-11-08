import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, chatButton } from './helpers';

for (const width of [1280, 375])
  test(`creates, filters, edits and deletes a Telegram folder at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openReady(page);
    await page.setViewportSize({ width, height: 800 });
    if (width <= 650)
      await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
    await page.getByRole('button', { name: 'Edit chat folders', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Chat Folders', exact: true });
    await modal.getByRole('button', { name: 'Create New Folder' }).click();
    await modal.getByLabel('Folder name', { exact: true }).fill('Work');
    await modal.getByRole('button', { name: 'Included Chats' }).click();
    await modal.getByRole('checkbox', { name: 'Groups', exact: true }).check();
    await modal.getByRole('button', { name: 'Done', exact: true }).click();
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(modal.getByRole('button', { name: /Work.*Groups/ })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`folders-${width}.png`),
      animations: 'disabled',
    });
    await modal.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Work', exact: true }).click();
    await expect(chatButton(page, /Fixture Group/)).toBeVisible();
    await expect(chatButton(page, /Alice Fixture/)).toHaveCount(0);
    await expect(chatButton(page, /Release Channel/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit chat folders', exact: true }).click();
    await modal.getByRole('button', { name: /Work.*Groups/ }).click();
    await modal.getByRole('button', { name: 'Delete Folder', exact: true }).click();
    await modal.getByRole('button', { name: 'Delete Folder', exact: true }).click();
    await modal.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Work', exact: true })).toHaveCount(0);
    await expect(chatButton(page, /Alice Fixture/)).toBeVisible();
  });

test('creates and revokes a shared-folder link, previews and joins an invitation', async ({
  page,
}) => {
  await openReady(page);
  await page.getByRole('button', { name: 'Edit chat folders', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Chat Folders', exact: true });
  await modal.getByRole('button', { name: 'Create New Folder' }).click();
  await modal.getByLabel('Folder name', { exact: true }).fill('Team');
  await modal.getByRole('button', { name: 'Included Chats' }).click();
  await modal.getByRole('checkbox', { name: /Fixture Group/ }).check();
  await modal.getByRole('button', { name: 'Done', exact: true }).click();
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await modal.getByRole('button', { name: /Team.*selected chats/ }).click();
  await modal.getByRole('button', { name: 'Invite Links', exact: true }).click();
  await modal.getByRole('button', { name: 'Create Invite Link', exact: true }).click();
  await modal.getByLabel('Link name', { exact: true }).fill('Friends');
  await modal.getByRole('button', { name: 'Create Link', exact: true }).click();
  await expect(modal.getByRole('textbox', { name: 'Folder invitation link' })).toHaveValue(
    /https:\/\/t.me\/addlist\//,
  );
  await modal.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(modal.getByRole('textbox', { name: 'Folder invitation link' })).toHaveCount(0);
  await modal.getByRole('button', { name: 'Back', exact: true }).click();
  await modal.getByRole('button', { name: 'Chat Folders', exact: true }).click();
  await modal.getByRole('button', { name: 'Add Folder by Link', exact: true }).click();
  await modal.getByLabel('Folder link', { exact: true }).fill('https://t.me/addlist/shared');
  await modal.getByRole('button', { name: 'Preview Folder', exact: true }).click();
  await expect(modal.getByRole('checkbox', { name: /Fixture Group/ })).toBeChecked();
  await modal.getByRole('button', { name: 'Add Folder', exact: true }).click();
  await expect(
    modal.getByRole('button', { name: 'Shared Shared folder', exact: true }),
  ).toBeVisible();
  await modal.getByRole('button', { name: 'Shared Shared folder', exact: true }).click();
  await modal.getByRole('button', { name: /New Chats/ }).click();
  await expect(modal.getByRole('checkbox', { name: /Release Channel/ })).toBeChecked();
  await modal.getByRole('button', { name: 'Add Chats', exact: true }).click();
  await expect(modal.getByText('Chats added.', { exact: true })).toBeVisible();
  await modal.getByRole('button', { name: 'Shared Shared folder', exact: true }).click();
  await expect(modal.getByRole('button', { name: /New Chats/ })).toHaveCount(0);
  await modal.getByRole('button', { name: 'Included Chats' }).click();
  await expect(modal.getByRole('checkbox', { name: /Release Channel/ })).toBeChecked();
});

test('opens a folder invitation from a message without leaving the conversation', async ({
  page,
}, testInfo) => {
  await openReady(page);
  await chatButton(page, /Alice Fixture/).click();
  const url = 'https://t.me/addlist/from-message';
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(url);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('link', { name: url, exact: true }).last().click();
  const modal = page.getByRole('dialog', { name: 'Add Chat Folder', exact: true });
  await expect(modal.getByRole('checkbox', { name: /Fixture Group/ })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('folder-invite.png'), animations: 'disabled' });
  await modal.getByRole('button', { name: 'Add Folder', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Shared', exact: true })).toBeVisible();
});
