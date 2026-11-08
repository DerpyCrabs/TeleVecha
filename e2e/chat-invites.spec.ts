import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, chatButton } from './helpers';

for (const width of [1280, 375]) {
  test(`previews invitations, requests approval and joins at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openReady(page);
    await page.setViewportSize({ width, height: 800 });
    if (width <= 650)
      await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
    await chatButton(page, /Alice Fixture/).click();
    const openLink = async (hash: string) => {
      const url = `https://t.me/+${hash}`;
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(url);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByRole('link', { name: url, exact: true }).last().click();
    };
    await openLink('request');
    const invite = page.getByRole('dialog', { name: 'Chat invitation', exact: true });
    await expect(invite).toContainText('Invited community');
    await expect(invite).toContainText('42 members');
    await page.screenshot({
      path: testInfo.outputPath(`invite-${width}.png`),
      animations: 'disabled',
    });
    await invite.getByRole('button', { name: 'Request to join', exact: true }).click();
    const requested = page.getByRole('dialog', { name: 'Request sent', exact: true });
    await expect(requested).toContainText('administrators will review');
    await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');
    await requested.getByRole('button', { name: 'Done', exact: true }).click();
    await openLink('paid');
    await expect(invite).toContainText('paid subscription');
    await expect(invite.getByRole('button', { name: 'Join group', exact: true })).toHaveCount(0);
    await invite.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openLink('expired');
    await expect(invite.getByRole('alert')).toContainText('expired');
    await invite.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openLink('welcome');
    await invite.getByRole('button', { name: 'Join group', exact: true }).click();
    await expect(invite).toHaveCount(0);
    await expect(page.getByTestId('conversation-header')).toContainText('Invited community');
  });
}
