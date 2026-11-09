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
    const menu = page.getByRole('menu', { name: 'Message actions' });
    await expect(menu.getByRole('menuitem').first()).toHaveText('Reply');
    await expect(menu.getByRole('menuitem').last()).toHaveClass(/message-read-status/);
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

for (const width of [375, 1280]) {
  for (const unread of [false, true]) {
    test(`${unread ? 'Unread' : 'Read'} status stays below message actions and has no disabled hover at ${width}px`, async ({
      page,
    }) => {
      await openReady(page, `/?chat=u%3A101${unread ? '&scenario=unread-receipts' : ''}`);
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() =>
        window.__televechaFixture!.emit({
          type: 'new-message',
          pts: 11,
          ptsCount: 1,
          message: {
            id: 901,
            peerId: 'u:101',
            senderId: 'self',
            text: 'Read status menu target',
            date: Math.floor(Date.now() / 1000),
            outgoing: true,
          },
        }),
      );
      await page.locator('article[data-message-id="901"]').click({ button: 'right' });
      const menu = page.getByRole('menu', { name: 'Message actions' });
      const status = menu.locator('.message-read-status');
      await expect(status).toContainText(unread ? 'Not read yet' : /^Read /);
      await expect(status).toBeDisabled();
      await expect(menu.getByRole('menuitem').first()).toHaveText('Reply');
      await expect(menu.getByRole('menuitem').last()).toHaveClass(/message-read-status/);
      await status.hover({ force: true });
      const style = await status.evaluate((element) => {
        const css = getComputedStyle(element);
        return {
          background: css.backgroundColor,
          top: css.borderTopWidth,
          bottom: css.borderBottomWidth,
        };
      });
      expect(style).toEqual({ background: 'rgba(0, 0, 0, 0)', top: '1px', bottom: '0px' });
      await page.screenshot({ path: `/tmp/read-status-menu-${unread}-${width}.png` });
      await menu.getByRole('menuitem', { name: 'Reply', exact: true }).click();
      await expect(page.getByTestId('composer-reply')).toContainText('Read status menu target');
    });
  }
}
