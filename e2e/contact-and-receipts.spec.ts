import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';

for (const width of [375, 1280]) {
  test(`contact cards open chats, add contacts and preserve vCards at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openReady(page, '/?chat=g%3A303');
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => {
      const contact = {
        firstName: 'Alice',
        lastName: 'Fixture',
        phoneNumber: '+79991234567',
        vcard: '',
        peer: { id: 'u:101', kind: 'user' as const, accessHash: '1' },
        hasAvatar: true,
      };
      window.__televechaFixture!.emit({
        type: 'new-message',
        pts: 11,
        ptsCount: 1,
        message: {
          id: 901,
          peerId: 'g:303',
          senderId: 'u:101',
          text: '',
          date: Math.floor(Date.now() / 1000),
          outgoing: false,
          contact,
        },
      });
    });
    const card = page.getByRole('region', { name: 'Contact: Alice Fixture' });
    await expect(card).toBeInViewport();
    await expect(card.getByRole('link', { name: '+79991234567' })).toHaveAttribute(
      'href',
      'tel:+79991234567',
    );
    const vcard = await card
      .getByRole('link', { name: 'Save contact', exact: true })
      .getAttribute('href');
    expect(decodeURIComponent(vcard!)).toContain('FN:Alice Fixture');
    expect(decodeURIComponent(vcard!)).toContain('+79991234567');
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('contact-card.png'),
    });
    await card.getByRole('button', { name: 'Add contact', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText('Contact added');
    expect(await page.evaluate(() => window.__televechaFixture!.stats.updateContact)).toBe(1);
    await card.getByRole('button', { name: 'Open chat', exact: true }).click();
    await expect(page).toHaveURL(/chat=u%3A101/);
    await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');
  });

  test(`group read receipts show people, avatars and dates at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openReady(page, '/?chat=g%3A303');
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => {
      window.__televechaFixture!.emit({
        type: 'new-message',
        pts: 11,
        ptsCount: 1,
        message: {
          id: 901,
          peerId: 'g:303',
          senderId: 'self',
          text: 'Read receipt target',
          date: Math.floor(Date.now() / 1000),
          outgoing: true,
        },
      });
    });
    await page.locator('article[data-message-id="901"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Read by 2/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Read by 2', exact: true });
    await expect(dialog.locator('.read-receipt-person')).toHaveCount(2);
    await expect(dialog).toContainText('Fixture Author');
    await expect(dialog).toContainText('Another Member');
    const times = await dialog
      .locator('time')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('datetime')));
    expect(times.every((value) => value && Number.isFinite(Date.parse(value)))).toBe(true);
    await expect(dialog.locator('[data-avatar-identity]')).toHaveCount(2);
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('read-receipts.png'),
    });
    await dialog.getByRole('button', { name: /Fixture Author/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/chat=u%3A404/);
  });
}
