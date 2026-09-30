import { test } from '@playwright/test';
import { expect } from './expect';

import { fixtureStats, openReady, selectAlice } from './helpers';

test('searches messages, paginates and reveals an old result', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('searches the current chat and all chats through Telegram', async () => {
    await page.getByRole('button', { name: 'Search messages' }).click();
    const search = page.getByRole('dialog', { name: 'Message search' });
    await search.getByRole('textbox', { name: 'Message search query' }).fill('Fixture message 79');
    await search.getByRole('textbox', { name: 'Message search query' }).press('Enter');
    await expect(
      search.getByRole('button', { name: /Alice Fixture.*Fixture message 79/ }),
    ).toBeVisible();
    await search.getByRole('button', { name: 'All chats' }).click();
    await search.getByRole('textbox', { name: 'Message search query' }).fill('Release notes');
    await search.getByRole('textbox', { name: 'Message search query' }).press('Enter');
    await expect(
      search.getByRole('button', { name: /Release Channel.*Release notes/ }),
    ).toBeVisible();
    // The scope-change search can be interrupted when the next query is entered.
    const requests = (await fixtureStats(page))?.searchMessages;
    expect(requests).toBeGreaterThanOrEqual(2);
    expect(requests).toBeLessThanOrEqual(3);
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Message search' })).toHaveCount(0);
  await test.step('paginates search results and discards the old cursor when the query changes', async () => {
    await page.getByRole('button', { name: 'Search messages' }).click();
    const search = page.getByRole('dialog', { name: 'Message search' });
    const query = search.getByRole('textbox', { name: 'Message search query' });
    await query.fill('Fixture message');
    await query.press('Enter');
    await expect(search.getByRole('button', { name: 'Load more' })).toBeVisible();
    await expect(
      search.getByRole('button', { name: 'Alice Fixture Fixture message 1', exact: true }),
    ).toHaveCount(0);

    await search.getByRole('button', { name: 'Load more' }).click();
    await expect(
      search.getByRole('button', { name: 'Alice Fixture Fixture message 1', exact: true }),
    ).toBeVisible();

    await query.fill('Release notes');
    await expect(search.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    await expect(search.getByRole('button', { name: /Fixture message/ })).toHaveCount(0);
    await search.getByRole('button', { name: 'All chats' }).click();
    await expect(
      search.getByRole('button', { name: /Release Channel.*Release notes/ }),
    ).toBeVisible();
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Message search' })).toHaveCount(0);
  await test.step('loads and reveals an old search result outside the current history window', async () => {
    await page.getByRole('button', { name: 'Search messages' }).click();
    const search = page.getByRole('dialog', { name: 'Message search' });
    await search.getByRole('textbox', { name: 'Message search query' }).fill('Fixture message 5');
    await search.getByRole('textbox', { name: 'Message search query' }).press('Enter');
    await search
      .getByRole('button', { name: 'Alice Fixture Fixture message 5', exact: true })
      .click();
    await expect(page.locator('article[data-message-id="5"]')).toBeInViewport();
    expect((await fixtureStats(page))?.getHistoryAround).toBe(1);
  });
});

test('shows the profile and mutes, pins, blocks and deletes from the chat menu', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('shows and caches Telegram user profile fields', async () => {
    const details = page.locator('.details-pane');
    await expect(details.getByText('+1 555 010 2048')).toBeVisible();
    await expect(details.getByText('Fixture profile used by end-to-end tests.')).toBeVisible();
    await expect(details.getByRole('link', { name: 'alice@example.com' })).toHaveAttribute(
      'href',
      'mailto:alice@example.com',
    );
    await expect(details.getByRole('link', { name: 'https://example.com' })).toHaveAttribute(
      'href',
      'https://example.com/',
    );
    await expect(details.getByRole('link', { name: '@telegram' })).toHaveAttribute(
      'href',
      'https://t.me/telegram',
    );
    await expect(details.getByRole('link', { name: /@alice_fixture/ })).toHaveAttribute(
      'href',
      'https://t.me/alice_fixture',
    );
    await expect(details.getByText('March 14, 1994')).toBeVisible();
    await expect(details.getByText('Birthday', { exact: true })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Share this contact' })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Edit contact' })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Delete contact' })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Block user' })).toBeVisible();
    expect((await fixtureStats(page))?.getUserDetails).toBe(1);

    await page.reload();
    await openReady(page);
    await selectAlice(page);
    await expect(page.locator('.details-pane').getByText('+1 555 010 2048')).toBeVisible();
    expect((await fixtureStats(page))?.getUserDetails).toBe(0);
  });
  await test.step('mutes and unmutes a chat from its context menu, not the details pane', async () => {
    const chat = page.getByRole('button', { name: /Alice Fixture/ });
    await expect(page.locator('.details-pane').getByRole('button', { name: /mute/i })).toHaveCount(
      0,
    );
    await chat.click({ button: 'right' });
    await page
      .getByRole('menu', { name: 'Chat actions' })
      .getByRole('menuitem', { name: 'Mute' })
      .click();
    await chat.click({ button: 'right' });
    await page
      .getByRole('menu', { name: 'Chat actions' })
      .getByRole('menuitem', { name: 'Unmute' })
      .click();
    expect((await fixtureStats(page))?.setMuted).toBe(2);
  });
  await test.step('pins, unpins, blocks, and unblocks from the chat context menu', async () => {
    const chat = page.getByRole('button', { name: /Alice Fixture/ });
    await chat.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin chat' }).click();
    await chat.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Unpin chat' }).click();

    await chat.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Block user' }).click();
    await chat.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Unblock user' }).click();

    const stats = await fixtureStats(page);
    expect(stats?.setPinnedDialog).toBe(2);
    expect(stats?.setBlocked).toBe(2);
  });
  await test.step('confirms chat deletion and removes the deleted chat', async () => {
    const chat = page.getByRole('button', { name: /Alice Fixture/ });
    await chat.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete chat' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete chat' });
    await expect(dialog).toContainText('Alice Fixture');
    await dialog.getByRole('button', { name: 'Delete for everyone' }).click();

    await expect(chat).toHaveCount(0);
    await expect(page.getByText('Release Channel', { exact: true }).first()).toBeVisible();
    await expect(page.locator('.chat-header')).toContainText('Release Channel');
    await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready');
    expect((await fixtureStats(page))?.deleteDialog).toBe(1);
  });
});

test('navigates every pinned message and opens an old pin outside loaded history', async ({
  page,
}) => {
  await page.goto('/?scenario=multiple-pins');
  await selectAlice(page);
  await expect(
    page.getByRole('button', { name: /Pinned message 1 of 2.*Fixture message 79/ }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Next pinned message' }).click();
  const oldPin = page.getByRole('button', { name: /Pinned message 2 of 2.*Fixture message 5/ });
  await expect(oldPin).toContainText('Fixture message 5');
  await oldPin.click();
  await expect(page.locator('article[data-message-id="5"]')).toBeInViewport();
  expect((await fixtureStats(page))?.getHistoryAround).toBe(1);
});
