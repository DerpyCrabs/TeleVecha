import { test, type Page } from '@playwright/test';
import { expect } from './expect';

import { chatButton, openReady, selectAlice } from './helpers';

async function navigateToChat(page: Page, peerId: string) {
  await page.evaluate((nextPeerId) => {
    const url = new URL(window.location.href);
    url.searchParams.set('chat', nextPeerId);
    window.history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, peerId);
}

async function openAlice(page: Page, path = '/') {
  await openReady(page, path);
  await selectAlice(page);
}

test('switches peer identity and conversation state atomically', async ({ page }) => {
  await openAlice(page);
  const details = page.locator('aside.details-pane');
  await expect(details.getByRole('button', { name: 'Photos 128' })).toBeVisible();

  await chatButton(page, /Release Channel/).click();

  await expect(page.getByTestId('conversation-header')).toContainText('Release Channel');
  await expect(details.getByRole('heading', { name: 'Release Channel' })).toBeVisible();
  await expect(page.getByTestId('message-scroller')).not.toContainText(
    'Newest message from fixture',
  );
  await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready');
  await expect(details.getByRole('button', { name: 'Photos 128' })).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Photos 7' })).toBeEnabled();
});

test('derives bot start state from the selected bot conversation', async ({ page }) => {
  await openAlice(page);
  const search = page.getByRole('textbox', { name: 'Search chats' });
  await search.fill('helper');
  await page.getByTestId('peer-search-result').filter({ hasText: 'Fixture Helper Bot' }).click();
  await expect(page.getByRole('button', { name: 'Start bot' })).toBeVisible();
  await expect(page.getByTestId('conversation-header')).toContainText('Fixture Helper Bot');
  await expect(page.getByRole('button', { name: 'Start bot' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveCount(0);
});

test('does not show an old history error under the newly selected peer', async ({ page }) => {
  await openAlice(page);
  await page.evaluate(() => {
    window.__televechaFixture?.failNextHistory('g:303', 'Held group history failure');
  });

  await chatButton(page, /Fixture Group/).click();
  const historyError = page.getByRole('alert').filter({ hasText: 'Messages could not be loaded' });
  await expect(historyError).toContainText('Held group history failure');
  await chatButton(page, /Release Channel/).click();

  await expect(page.getByTestId('conversation-header')).toContainText('Release Channel');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Held group history failure' }),
  ).toHaveCount(0);
  await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready');
});

test('closes old-chat shared content when browser navigation selects another chat', async ({
  page,
}) => {
  await openAlice(page);
  await page
    .locator('aside.details-pane')
    .getByRole('button', { name: /Photos/ })
    .click();
  await expect(page.getByRole('dialog', { name: 'Shared photos' })).toBeVisible();

  await navigateToChat(page, 'c:202');

  await expect(page.getByTestId('conversation-header')).toContainText('Release Channel');
  await expect(page.getByRole('dialog', { name: 'Shared photos' })).toHaveCount(0);
});

test('closes old-chat message actions when browser navigation selects another chat', async ({
  page,
}) => {
  await openAlice(page);
  const message = page.locator('article[data-message-id="79"]');
  await message.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Forward' }).click();
  await expect(page.getByRole('dialog', { name: 'Forward message' })).toBeVisible();

  await navigateToChat(page, 'c:202');

  await expect(page.getByTestId('conversation-header')).toContainText('Release Channel');
  await expect(page.getByRole('dialog', { name: 'Forward message' })).toHaveCount(0);

  await navigateToChat(page, 'u:101');
  await expect(page.getByTestId('message-scroller')).toContainText('Newest message from fixture');
  await message.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete message' })).toBeVisible();

  await navigateToChat(page, 'c:202');

  await expect(page.getByRole('dialog', { name: 'Delete message' })).toHaveCount(0);
});

test('closes search, reaction, sidebar, and formatting state on peer changes', async ({ page }) => {
  await openAlice(page);
  await page.getByRole('button', { name: 'Search messages' }).click();
  await expect(page.locator('.search-panel[aria-label="Message search"]')).toBeVisible();

  await navigateToChat(page, 'c:202');

  await expect(page.locator('.search-panel[aria-label="Message search"]')).toHaveCount(0);
  await navigateToChat(page, 'u:101');
  await expect(page.getByTestId('message-scroller')).toContainText('Newest message from fixture');

  await page.getByRole('button', { name: 'React to message 79' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose reaction' })).toBeVisible();
  await navigateToChat(page, 'c:202');
  await navigateToChat(page, 'u:101');
  await expect(page.getByTestId('message-scroller')).toContainText('Newest message from fixture');
  await expect(page.getByRole('dialog', { name: 'Choose reaction' })).toHaveCount(0);

  await chatButton(page, /Alice Fixture/).click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Chat actions' })).toBeVisible();
  await navigateToChat(page, 'c:202');
  await expect(page.getByRole('menu', { name: 'Chat actions' })).toHaveCount(0);

  await navigateToChat(page, 'u:101');
  const input = page.getByRole('textbox', { name: 'Message' });
  await input.fill('format me');
  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(0, 6));
  await input.dispatchEvent('contextmenu', { clientX: 400, clientY: 500 });
  await expect(page.getByRole('menu', { name: 'Message formatting' })).toBeVisible();
  await navigateToChat(page, 'c:202');
  await expect(page.getByRole('menu', { name: 'Message formatting' })).toHaveCount(0);
});

test('does not reopen an old chat image editor when returning to its draft', async ({ page }) => {
  await openAlice(page);
  await page
    .locator('.chat-composer input[type="file"]')
    .setInputFiles('e2e/fixtures/outgoing-media.png');
  await page.getByRole('button', { name: 'Edit image outgoing-media.png' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit image' })).toBeVisible();

  await navigateToChat(page, 'c:202');

  await expect(page.getByRole('dialog', { name: 'Edit image' })).toHaveCount(0);
  await navigateToChat(page, 'u:101');
  await expect(
    page
      .getByTestId('composer-attachment')
      .getByRole('button', { name: 'Edit image outgoing-media.png' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Edit image' })).toHaveCount(0);
});

test('does not retain a stale starting state after leaving a bot chat', async ({ page }) => {
  await openAlice(page);
  const search = page.getByRole('textbox', { name: 'Search chats' });
  await search.fill('helper');
  await page.getByTestId('peer-search-result').filter({ hasText: 'Fixture Helper Bot' }).click();
  await page.evaluate(() => window.__televechaFixture?.holdNextBotStart());

  await page.getByRole('button', { name: 'Start bot' }).click();
  await expect(page.getByRole('button', { name: 'Starting…' })).toBeDisabled();
  await chatButton(page, /Alice Fixture/).click();
  await page.evaluate(() => window.__televechaFixture?.releaseBotStart());
  await navigateToChat(page, 'u:606');
  await expect(page.getByRole('button', { name: 'Starting…' })).toHaveCount(0);
  await expect(page.getByTestId('message-scroller')).toContainText('Fixture delayed bot action');
});
