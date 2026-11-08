import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, chatButton } from './helpers';
for (const width of [1280, 375]) {
  test(`manages participants, administrators and restrictions at ${width}px`, async ({
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
    await page
      .getByRole('dialog', { name: 'Manage group', exact: true })
      .getByRole('button', { name: 'Members', exact: true })
      .click();
    const members = page.getByRole('dialog', { name: 'Members', exact: true });
    await expect(members.getByRole('button', { name: /Nina Member/ })).toBeVisible();
    await members.getByRole('button', { name: /Alex Admin/ }).click();
    const locked = page.getByRole('dialog', { name: 'Alex Admin', exact: true });
    await expect(locked).toContainText('do not have permission');
    await expect(
      locked.getByRole('button', { name: 'Edit administrator', exact: true }),
    ).toHaveCount(0);
    await locked.getByRole('button', { name: 'Back', exact: true }).click();
    await members.getByRole('button', { name: /Nina Member/ }).click();
    const person = page.getByRole('dialog', { name: 'Nina Member', exact: true });
    await person.getByRole('button', { name: 'Add as administrator', exact: true }).click();
    const admin = page.getByRole('dialog', { name: 'Administrator permissions', exact: true });
    await admin.getByRole('checkbox', { name: 'Add administrators', exact: true }).check();
    await admin
      .getByRole('textbox', { name: 'Administrator title (optional)', exact: true })
      .fill('Team lead');
    await admin.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded();
    const titleBox = await admin
      .getByRole('textbox', { name: 'Administrator title (optional)', exact: true })
      .boundingBox();
    const saveBox = await admin.getByRole('button', { name: 'Save', exact: true }).boundingBox();
    expect(titleBox).not.toBeNull();
    expect(saveBox).not.toBeNull();
    expect(titleBox!.y + titleBox!.height).toBeLessThanOrEqual(saveBox!.y);
    await page.screenshot({
      path: testInfo.outputPath(`admin-${width}.png`),
      animations: 'disabled',
    });
    await admin.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(members.getByRole('button', { name: /Nina Member/ })).toContainText('Team lead');
    await members.getByRole('button', { name: /Nina Member/ }).click();
    await person.getByRole('button', { name: 'Edit administrator', exact: true }).click();
    await admin.getByRole('button', { name: 'Remove administrator', exact: true }).click();
    const demote = page.getByRole('dialog', { name: 'Remove administrator?', exact: true });
    await demote.getByRole('button', { name: 'Remove administrator', exact: true }).click();
    await members.getByRole('button', { name: /Nina Member/ }).click();
    await person.getByRole('button', { name: 'Restrict user', exact: true }).click();
    const restriction = page.getByRole('dialog', { name: 'User permissions', exact: true });
    await expect(
      restriction.getByRole('checkbox', { name: 'Send polls', exact: true }),
    ).toBeDisabled();
    await restriction.getByRole('checkbox', { name: 'Send photos', exact: true }).uncheck();
    await restriction
      .getByRole('combobox', { name: 'Restriction duration', exact: true })
      .selectOption('day');
    await restriction.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(members.getByRole('button', { name: /Nina Member/ })).toContainText('restricted');
    await members.getByRole('button', { name: /Nina Member/ }).click();
    await person.getByRole('button', { name: 'Remove member', exact: true }).click();
    const removal = page.getByRole('dialog', { name: 'Remove member?', exact: true });
    await removal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await person.getByRole('button', { name: 'Remove member', exact: true }).click();
    await removal.getByRole('button', { name: 'Remove member', exact: true }).click();
    await expect(members.getByRole('button', { name: /Nina Member/ })).toHaveCount(0);
    await members.getByRole('button', { name: 'Removed users', exact: true }).click();
    const removed = page.getByRole('dialog', { name: 'Removed users', exact: true });
    await removed.getByRole('button', { name: /Nina Member/ }).click();
    await person.getByRole('button', { name: 'Allow to rejoin', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Allow this user to rejoin?', exact: true })
      .getByRole('button', { name: 'Allow to rejoin', exact: true })
      .click();
    await expect(removed.getByRole('button', { name: /Nina Member/ })).toHaveCount(0);
    await removed.getByRole('button', { name: 'Members', exact: true }).click();
    await members.getByRole('button', { name: 'Add member', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Add member', exact: true })
      .getByRole('button', { name: /Alice Fixture/ })
      .click();
    await expect(members.getByRole('button', { name: /Alice Fixture/ })).toBeVisible();
  });
}
