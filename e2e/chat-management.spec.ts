import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, chatButton } from './helpers';
for (const width of [1280, 375]) {
  test(`edits forum settings and keeps changes separate at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openReady(page, '/?scenario=forums');
    await page.setViewportSize({ width, height: 800 });
    if (width <= 650)
      await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
    await chatButton(page, /Release Channel/).click();
    await page
      .getByRole('complementary', { name: 'Forum topics' })
      .getByRole('button', { name: /^General/ })
      .click();
    if (await page.getByRole('button', { name: 'Open details', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Open details', exact: true }).click();
    await page.getByRole('button', { name: 'Manage group', exact: true }).click();
    const manager = page.getByRole('dialog', { name: 'Manage group', exact: true });
    await expect(manager.getByRole('button', { name: /^Topics/ })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`management-${width}.png`),
      animations: 'disabled',
    });
    await manager.getByRole('button', { name: /^Permissions/ }).click();
    const permissions = page.getByRole('dialog', { name: 'Permissions', exact: true });
    await expect(
      permissions.getByRole('checkbox', { name: 'Send polls', exact: true }),
    ).not.toBeChecked();
    await permissions.getByRole('checkbox', { name: 'Send photos', exact: true }).uncheck();
    await permissions.getByRole('button', { name: 'Save', exact: true }).click();
    await manager.getByRole('button', { name: /^Permissions/ }).click();
    await expect(
      permissions.getByRole('checkbox', { name: 'Send photos', exact: true }),
    ).not.toBeChecked();
    await permissions.getByRole('checkbox', { name: 'Send photos', exact: true }).check();
    await permissions.getByRole('button', { name: 'Cancel', exact: true }).click();
    await manager.getByRole('button', { name: /^Permissions/ }).click();
    await expect(
      permissions.getByRole('checkbox', { name: 'Send photos', exact: true }),
    ).not.toBeChecked();
    await permissions.getByRole('button', { name: 'Cancel', exact: true }).click();
    await manager.getByRole('button', { name: /^Name/ }).click();
    const name = page.getByRole('dialog', { name: 'Name', exact: true });
    await name.getByRole('textbox', { name: 'Name', exact: true }).fill('Team forum');
    await name.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(manager.getByRole('button', { name: /^Name/ })).toContainText('Team forum');
    await expect(page.getByTestId('conversation-header')).toContainText('Team forum');
    await manager.getByRole('button', { name: /^Description/ }).click();
    const description = page.getByRole('dialog', { name: 'Description', exact: true });
    await description.getByRole('textbox', { name: 'Description', exact: true }).fill('Not saved');
    await description.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(manager).not.toContainText('Not saved');
    await manager.getByRole('button', { name: /^Slow mode/ }).click();
    const slow = page.getByRole('dialog', { name: 'Slow mode', exact: true });
    await slow.getByRole('combobox', { name: 'Message interval' }).selectOption('30');
    await slow.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(manager.getByRole('button', { name: /^Slow mode/ })).toContainText('30 seconds');
    await manager.getByRole('button', { name: /^Chat type/ }).click();
    const type = page.getByRole('dialog', { name: 'Chat type', exact: true });
    await type.getByRole('radio', { name: /^Public/ }).check();
    await type.getByRole('textbox', { name: 'Public username' }).fill('team_forum');
    await type.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(manager).toContainText('t.me/team_forum');
    await manager.getByRole('button', { name: /^Content protection/ }).click();
    const protection = page.getByRole('dialog', { name: 'Content protection', exact: true });
    await protection.getByRole('radio', { name: 'Enabled', exact: true }).check();
    await protection.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(manager.getByRole('button', { name: /^Content protection/ })).toContainText(
      'Enabled',
    );
    await manager.getByRole('button', { name: 'Invitation links', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Invitation links', exact: true })
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await expect(manager).toBeVisible();
    await manager.getByRole('button', { name: /^Topics/ }).click();
    const topics = page.getByRole('dialog', { name: 'Topics', exact: true });
    await topics.getByRole('radio', { name: 'Disabled', exact: true }).check();
    await topics.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(manager).toHaveCount(0);
    await expect(page.getByTestId('conversation-header')).toContainText('Team forum');
    await expect(
      page
        .getByTestId('conversation-header')
        .getByRole('button', { name: 'Show topics', exact: true }),
    ).toHaveCount(0);
  });
}

test('hides settings outside the current administrator rights', async ({ page }) => {
  await openReady(page, '/?scenario=management-limited');
  await chatButton(page, /Release Channel/).click();
  await page.getByRole('button', { name: 'Manage channel', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Manage channel', exact: true });
  await expect(manager.getByRole('button', { name: /^Name/ })).toBeVisible();
  await expect(manager.getByRole('button', { name: /^Chat type/ })).toHaveCount(0);
  await expect(manager.getByRole('button', { name: /^Content protection/ })).toHaveCount(0);
});
