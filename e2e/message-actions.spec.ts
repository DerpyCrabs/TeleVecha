import { test } from '@playwright/test';
import { expect } from './expect';

import { fixtureStats, openReady, selectAlice } from './helpers';

test('copies, edits, selects, pins and deletes from the message menu', async ({
  page,
  context,
}) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('copies regular and rich message text from the context menu', async () => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const regular = page.locator('article[data-message-id="80"]');
    await regular.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy text' }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('Newest message from fixture');

    const rich = page.locator('article[data-message-id="74"]');
    await rich.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy text' }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(
        [
          'Rich Markdown',
          'Highlighted and hidden',
          '- [x] Rendered task',
          'Feature\tStatus',
          'More\nNested content',
        ].join('\n\n'),
      );
  });
  await test.step('allows the native context menu on image content', async () => {
    const image = page.getByRole('img', { name: 'fixture.jpg', exact: true });
    await expect(image).toBeVisible();

    const inlineAllowed = await image.evaluate((element) =>
      element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    expect(inlineAllowed).toBe(true);
    await expect(page.getByRole('menu', { name: 'Message actions' })).toHaveCount(0);

    await image.click();
    const preview = page.getByRole('dialog', { name: /Media preview:/ }).getByRole('img');
    await expect(preview).toBeVisible();
    const previewAllowed = await preview.evaluate((element) =>
      element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    expect(previewAllowed).toBe(true);
    await expect(page.getByRole('menu', { name: 'Media actions' })).toHaveCount(0);
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /Media preview:/ })).toHaveCount(0);
  await test.step('focuses the composer when editing from a message menu', async () => {
    await page.locator('article[data-message-id="80"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Edit' }).click();

    const input = page.getByRole('textbox', { name: 'Message' });
    await expect(page.getByTestId('composer-edit')).toBeVisible();
    await expect(input).toHaveValue('Newest message from fixture');
    await expect(input).toBeFocused();
  });
  await page.getByRole('textbox', { name: 'Message' }).press('Escape');
  await expect(page.getByTestId('composer-edit')).toHaveCount(0);
  await test.step('selects a range, toggles messages, and cancels with Escape', async () => {
    await page.locator('article[data-message-id="80"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
    const toolbar = page.getByRole('toolbar', { name: 'Selected messages' });
    await expect(toolbar).toContainText('1 selected');
    await page.locator('article[data-message-id="78"]').click({ modifiers: ['Shift'] });
    await expect(toolbar).toContainText('3 selected');
    await page.getByRole('checkbox', { name: 'Select message 79', exact: true }).click();
    await expect(toolbar).toContainText('2 selected');
    await expect(
      page.getByRole('checkbox', { name: 'Select message 79', exact: true }),
    ).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(toolbar).toHaveCount(0);
    await page.locator('article[data-message-id="80"]').click({ modifiers: ['Control'] });
    await expect(toolbar).toContainText('1 selected');
    await page.getByRole('button', { name: 'Cancel selection' }).click();
    await expect(toolbar).toHaveCount(0);
  });
  await test.step('pins and unpins a message and exposes the pinned-message bar', async () => {
    const message = page.locator('article[data-message-id="79"]');
    await message.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await expect(
      page.getByRole('button', { name: /Pinned message.*Fixture message 79/ }),
    ).toBeVisible();
    await message.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();
    await expect(page.getByRole('button', { name: /Pinned message/ })).toHaveCount(0);
    expect((await fixtureStats(page))?.setPinnedMessage).toBe(2);
  });
  await test.step('offers delete-for-me separately from revoke-for-everyone', async () => {
    const message = page.locator('article[data-message-id="80"]');
    await message.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete message' });
    await expect(dialog.getByRole('button', { name: 'Delete for me' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Delete for everyone' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete for me' }).click();
    await expect(message).toHaveCount(0);
    expect((await fixtureStats(page))?.deleteMessages).toBe(1);
  });
});

test('forwards selected messages in chronological order and clears selection on chat change', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  await page.locator('article[data-message-id="80"]').click({ modifiers: ['Control'] });
  await page.locator('article[data-message-id="79"]').click();
  await page.getByRole('button', { name: 'Forward selected' }).click();
  const dialog = page.getByRole('dialog', { name: 'Forward selected messages' });
  await dialog.getByRole('button', { name: 'Alice Fixture', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await fixtureStats(page))?.forwardMessage).toBe(2);
  await expect(page.locator('article[data-message-id="81"]')).toContainText('Fixture message 79');
  await expect(page.locator('article[data-message-id="82"]')).toContainText(
    'Newest message from fixture',
  );
  await expect(page.getByRole('toolbar', { name: 'Selected messages' })).toHaveCount(0);
  await page.locator('article[data-message-id="80"]').click({ modifiers: ['Control'] });
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Release Channel/ })
    .click();
  await expect(page.getByRole('toolbar', { name: 'Selected messages' })).toHaveCount(0);
});

test('selection intercepts media clicks and disables forwarding protected messages', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Protected selection',
        date: 1_700_002_000,
        outgoing: false,
        protected: true,
      },
    }),
  );
  await page.locator('article[data-message-id="81"]').click({ modifiers: ['Control'] });
  await expect(page.getByRole('button', { name: 'Forward selected' })).toBeDisabled();
  await page.getByRole('img', { name: 'fixture.jpg', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: 'Selected messages' })).toContainText(
    '2 selected',
  );
  await expect(page.getByRole('dialog', { name: /Media preview:/ })).toHaveCount(0);
  await page.locator('article[data-message-id="81"]').click();
  await expect(page.getByRole('button', { name: 'Forward selected' })).toBeEnabled();
});

test('selects album members together and deletes a selection', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('selects album members together', async () => {
    await page.evaluate(() => {
      for (const id of [81, 82])
        window.__televechaFixture?.emit({
          type: 'new-message',
          pts: id - 70,
          ptsCount: 1,
          message: {
            id,
            peerId: 'u:101',
            senderId: 'u:101',
            text: '',
            date: 1_700_002_000,
            outgoing: false,
            groupedId: 'selection-album',
            media: {
              kind: 'photo',
              name: `selection-${id}.jpg`,
              mimeType: 'image/jpeg',
              width: 200,
              height: 200,
            },
          },
        });
    });
    const album = page.locator('article[data-message-id="81"]');
    await expect(album.locator('.media-album-item')).toHaveCount(2);
    await album.click({ modifiers: ['Control'] });
    await expect(page.getByRole('toolbar', { name: 'Selected messages' })).toContainText(
      '2 selected',
    );
    await expect(
      page.getByRole('checkbox', { name: 'Select message 81', exact: true }),
    ).toBeChecked();
    await album.click();
    await expect(page.getByRole('toolbar', { name: 'Selected messages' })).toHaveCount(0);
  });
  await test.step('deletes selected messages after confirmation and retains unselected messages', async () => {
    await page.locator('article[data-message-id="80"]').click({ modifiers: ['Control'] });
    await page.locator('article[data-message-id="79"]').click();
    await page.getByRole('button', { name: 'Delete selected' }).click();
    let dialog = page.getByRole('dialog', { name: 'Delete 2 messages' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('toolbar', { name: 'Selected messages' })).toContainText(
      '2 selected',
    );
    await page.getByRole('button', { name: 'Delete selected' }).click();
    dialog = page.getByRole('dialog', { name: 'Delete 2 messages' });
    await dialog.getByRole('button', { name: 'Delete for me', exact: true }).click();
    await expect(page.locator('article[data-message-id="80"]')).toHaveCount(0);
    await expect(page.locator('article[data-message-id="79"]')).toHaveCount(0);
    await expect(page.locator('article[data-message-id="78"]')).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Selected messages' })).toHaveCount(0);
  });
});
