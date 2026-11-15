import { test, type Page } from '@playwright/test';
import { expect } from './expect';
import { chatButton, fixtureStats, openReady } from './helpers';

async function seedAlbum(page: Page, readInboxMaxId = 80) {
  await page.evaluate((readInboxMaxId) => {
    const fixture = window.__televechaFixture!;
    const messages = [81, 82, 83].map((id) => ({
      id,
      peerId: 'u:101',
      senderId: 'u:101',
      text: id === 82 ? 'Album caption on second photo' : '',
      date: 1_700_002_000,
      outgoing: false,
      groupedId: 'regression-album',
      media: {
        kind: 'photo' as const,
        name: `album-${id}.jpg`,
        mimeType: 'image/jpeg',
        width: 200,
        height: 200,
      },
    }));
    fixture.setMessages(messages);
    const dialog = [...window.__televechaRuntimes!.values()][0]!.engine
      .snapshot()
      .dialogs.find(({ peer }) => peer.id === 'u:101')!;
    fixture.emit({
      type: 'dialog-changed',
      dialog: {
        ...dialog,
        topMessageId: 83,
        topMessage: messages[2],
        readInboxMaxId,
        unreadCount: 83 - readInboxMaxId,
      },
    });
  }, readInboxMaxId);
  await expect(chatButton(page, /Alice Fixture/)).toHaveAccessibleName(
    new RegExp(`${83 - readInboxMaxId} unread messages`),
  );
}

for (const selection of [false, true]) {
  test(`forwards all album photos together from ${selection ? 'selection' : 'message menu'}`, async ({
    page,
  }) => {
    await openReady(page);
    await seedAlbum(page);
    await chatButton(page, /Alice Fixture/).click();
    const album = page.locator('article[data-message-id="81"]');
    await expect(album.locator('.media-album-item')).toHaveCount(3);
    await expect(album).toContainText('Album caption on second photo');
    // Use the caption, so this is an action on the album, not an individual image.
    const caption = album.getByText('Album caption on second photo', { exact: true });
    if (selection) {
      await caption.click({ modifiers: ['Control'] });
      await page.getByRole('button', { name: 'Forward selected' }).click();
    } else {
      await caption.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Forward', exact: true }).click();
    }
    await page
      .getByRole('dialog', { name: selection ? 'Forward selected messages' : 'Forward message' })
      .getByRole('button', { name: 'Alice Fixture', exact: true })
      .click();
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await fixtureStats(page))?.forwardMessage).toBe(1);
    const forwarded = page.locator('article[data-message-id="84"]');
    await expect(forwarded.locator('.media-album-item')).toHaveCount(3);
    await expect(forwarded).toContainText('Album caption on second photo');
    const sent = await page.evaluate(() =>
      [...window.__televechaRuntimes!.values()][0]!.engine
        .snapshot()
        .messages.filter(({ id }) => id >= 84),
    );
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map(({ groupedId }) => groupedId)).size).toBe(1);
    expect(sent[0]?.groupedId).toBeTruthy();
    expect(sent[0]?.groupedId).not.toBe('regression-album');
  });
}

test('counts album photos individually and places a partial-album unread divider on the visible row', async ({
  page,
}) => {
  await openReady(page);
  await seedAlbum(page, 81);
  await chatButton(page, /Alice Fixture/).click();
  const divider = page.locator('.unread-messages-divider');
  await expect(divider).toBeVisible();
  await expect(divider.locator('..').locator('article')).toHaveAttribute('data-message-id', '81');
  await expect(page.locator('article[data-message-id="81"] .media-album-item')).toHaveCount(3);
});

test('forwards only the explicitly viewed album photo from the media viewer', async ({ page }) => {
  await openReady(page);
  await seedAlbum(page);
  await chatButton(page, /Alice Fixture/).click();
  await page
    .locator('article[data-message-id="81"] .media-album-item')
    .nth(1)
    .getByRole('img')
    .click();
  await page
    .getByRole('dialog', { name: /Media preview:/ })
    .getByRole('button', { name: 'Forward message', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Forward message', exact: true })
    .getByRole('button', { name: 'Alice Fixture', exact: true })
    .click();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('article[data-message-id="84"]')).toContainText(
    'Album caption on second photo',
  );
  await expect(page.getByRole('button', { name: 'Forwarding options', exact: true })).toHaveCount(
    0,
  );
  const sent = await page.evaluate(() =>
    [...window.__televechaRuntimes!.values()][0]!.engine
      .snapshot()
      .messages.filter(({ id }) => id >= 84),
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]?.groupedId).toBeUndefined();
});
