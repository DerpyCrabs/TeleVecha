import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';

for (const width of [1280, 375]) {
  test(`creates a group and a private channel at ${width}px`, async ({ page }, testInfo) => {
    await openReady(page);
    await page.setViewportSize({ width, height: 800 });
    const open = async () => {
      if (width <= 650)
        await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
      await page.getByRole('button', { name: 'New message', exact: true }).click();
    };
    await open();
    await page.getByRole('button', { name: 'New group', exact: true }).click();
    const group = page.getByRole('dialog', { name: 'New group', exact: true });
    await expect(group.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    await group.getByRole('textbox', { name: 'Group name', exact: true }).fill('Weekend plans');
    await group.getByRole('button', { name: 'Next', exact: true }).click();
    const members = page.getByRole('dialog', { name: 'Add members', exact: true });
    await expect(members.getByRole('button', { name: 'Create group', exact: true })).toBeDisabled();
    await members.getByRole('checkbox', { name: /Alice Fixture/ }).check();
    await page.screenshot({
      path: testInfo.outputPath(`create-group-${width}.png`),
      animations: 'disabled',
    });
    await members.getByRole('button', { name: 'Create group', exact: true }).click();
    await expect(members).toHaveCount(0);
    await expect(page.locator('.chat-header')).toContainText('Weekend plans');
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Hello group');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByTestId('message-scroller')).toContainText('Hello group');
    await open();
    await page.getByRole('button', { name: 'New channel', exact: true }).click();
    const channel = page.getByRole('dialog', { name: 'New channel', exact: true });
    await channel
      .getByRole('textbox', { name: 'Channel name', exact: true })
      .fill('Our announcements');
    await channel
      .getByRole('textbox', { name: 'Description (optional)', exact: true })
      .fill('Updates for our team');
    await page.screenshot({
      path: testInfo.outputPath(`create-channel-${width}.png`),
      animations: 'disabled',
    });
    await channel.getByRole('button', { name: 'Create channel', exact: true }).click();
    await expect(channel).toHaveCount(0);
    await expect(page.locator('.chat-header')).toContainText('Our announcements');
  });
}

test('keeps a successfully created group when Telegram cannot invite a person', async ({
  page,
}) => {
  await openReady(page, '/?scenario=create-partial');
  await page.getByRole('button', { name: 'New message', exact: true }).click();
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByRole('textbox', { name: 'Group name', exact: true }).fill('Private invitations');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('checkbox', { name: /Alice Fixture/ }).check();
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  const result = page.getByRole('dialog', { name: 'New group', exact: true });
  await expect(result).toContainText('Your group has been created.');
  await expect(result).toContainText('Telegram could not add: Alice Fixture');
  await expect(result.getByRole('button', { name: 'Create group', exact: true })).toHaveCount(0);
  await result.getByRole('button', { name: 'Open group', exact: true }).click();
  await expect(result).toHaveCount(0);
  await expect(page.locator('.chat-header')).toContainText('Private invitations');
});
