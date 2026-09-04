import { expect, test } from '@playwright/test';

import { chatButton, openReady, selectAlice } from './helpers';

test.beforeEach(async ({ page }) => {
  await openReady(page);
});

test('shows the open dialog name in the browser tab title', async ({ page }) => {
  await selectAlice(page);
  await expect(page).toHaveTitle('Alice Fixture - TeleVecha');

  await chatButton(page, /Release Channel/).click();
  await expect(page.getByTestId('conversation-header')).toContainText('Release Channel');
  await expect(page).toHaveTitle('Release Channel - TeleVecha');
});

test('searches chat titles and message previews without changing the open chat', async ({
  page,
}) => {
  await selectAlice(page);
  const search = page.getByRole('textbox', { name: 'Search chats' });

  await search.fill('release notes');
  await expect(chatButton(page, /Release Channel/)).toBeVisible();
  await expect(chatButton(page, /Alice Fixture/)).toHaveCount(0);
  await expect(page.getByTestId('message-scroller')).toContainText('Newest message from fixture');

  await search.fill('does not exist');
  await expect(page.getByText('No chats found')).toBeVisible();
  await search.clear();
  await expect(chatButton(page, /Alice Fixture/)).toBeVisible();
});

test('filters unread chats and restores the complete list', async ({ page }) => {
  await page.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unread', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(chatButton(page, /Alice Fixture/)).toBeVisible();
  await expect(chatButton(page, /Fixture Group/)).toBeVisible();
  await expect(chatButton(page, /Release Channel/)).toHaveCount(0);

  await page.getByRole('button', { name: 'All' }).click();
  await expect(page.locator('[data-testid="chat-list"] .chat-row')).toHaveCount(3);
});

test('filters groups using the Telegram peer type', async ({ page }) => {
  await page.getByRole('button', { name: 'Groups' }).click();
  await expect(page.getByRole('button', { name: 'Groups' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(chatButton(page, /Fixture Group/)).toBeVisible();
  await expect(chatButton(page, /Alice Fixture/)).toHaveCount(0);
  await expect(chatButton(page, /Release Channel/)).toHaveCount(0);
});

test('combines the chat filter and search query', async ({ page }) => {
  await page.getByRole('button', { name: 'Groups' }).click();
  await page.getByRole('textbox', { name: 'Search chats' }).fill('release');
  await expect(page.getByText('No chats found')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search chats' }).fill('fixture');
  await expect(chatButton(page, /Fixture Group/)).toBeVisible();
});

test('archives and restores a chat from the Archived section', async ({ page }) => {
  const alice = chatButton(page, /Alice Fixture/);
  await alice.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive chat' }).click();

  await expect(alice).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(chatButton(page, /Alice Fixture/)).toBeVisible();

  await chatButton(page, /Alice Fixture/).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Unarchive chat' }).click();
  await expect(page.getByText('No archived chats')).toBeVisible();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(chatButton(page, /Alice Fixture/)).toBeVisible();
});

test('searches Telegram users, bots, public groups, and channels', async ({ page }) => {
  const search = page.getByRole('textbox', { name: 'Search chats' });
  await search.fill('remote fixture user');
  await expect(page.getByTestId('peer-search-result')).toContainText(
    '@remote_fixture_user · Telegram user',
  );

  await search.fill('fixture search contact');
  await expect(page.getByTestId('peer-search-result')).toContainText(
    '@fixture_search_contact · Contact',
  );

  await search.fill('helper');
  const bot = page.getByTestId('peer-search-result').filter({ hasText: 'Fixture Helper Bot' });
  await expect(bot).toContainText('@fixture_helper_bot · Bot');
  await bot.click();
  await expect(page.getByTestId('conversation-header')).toContainText('Fixture Helper Bot');

  await search.fill('public fixture group');
  await expect(page.getByTestId('peer-search-result')).toContainText(
    '@public_fixture_group · Public group',
  );

  await search.fill('public fixture');
  const channel = page.getByTestId('peer-search-result').filter({ hasText: 'Public Fixture News' });
  await expect(channel).toContainText('@public_fixture_news · Public channel');
});

test('does not let a slow Telegram search result steal newer navigation', async ({ page }) => {
  await chatButton(page, /Release Channel/).click();

  const search = page.getByRole('textbox', { name: 'Search chats' });
  await search.fill('remote fixture user');
  await page.getByTestId('peer-search-result').click();
  await chatButton(page, /Alice Fixture/).click();

  await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');
});

test('switches chats and updates messages, header, details, and global counts together', async ({
  page,
}) => {
  await selectAlice(page);
  await chatButton(page, /Release Channel/).click();

  await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready');
  await expect(page.getByTestId('conversation-header')).toContainText('Release Channel');
  await expect(page.locator('aside.details-pane')).toContainText(
    'Photos7Videos2Files3Audio files1Links12Voice messages4GIFs2',
  );
  await expect(page.getByTestId('message-scroller')).not.toContainText('Fixture message 79');
});

test('contains no remaining placeholder controls', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Choose emoji' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect to Telegram' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Search messages' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sound' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More' })).toHaveCount(0);
});
