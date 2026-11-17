import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, chatButton } from './helpers';

for (const width of [1280, 375])
  test(`forum topics keep history and drafts separate at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openReady(page, '/?scenario=forums');
    await page.setViewportSize({ width, height: 800 });
    if (width <= 650)
      await page.getByRole('button', { name: 'Open chat list', exact: true }).click();
    await chatButton(page, /Release Channel/).click();
    const topics = page.getByRole('complementary', { name: 'Forum topics' });
    await expect(topics.getByRole('button', { name: /^General/ })).toBeVisible();
    await topics.getByRole('button', { name: /^General/ }).click();
    const history = page.getByTestId('message-scroller');
    await expect(history.getByText('General message 119', { exact: true })).toBeVisible();
    await expect(history.getByText(/^Development message/)).toHaveCount(0);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await history.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(history.getByText('General message 1', { exact: true })).toBeVisible();
    await composer.fill('General draft');
    await page.getByRole('button', { name: 'Show topics', exact: true }).click();
    await topics.getByRole('button', { name: /^Development/ }).click();
    await expect(composer).toHaveValue('');
    await expect(history.getByText('Development message 120', { exact: true })).toBeVisible();
    await expect(history.getByText(/^General message/)).toHaveCount(0);
    await composer.fill('Sent to Development');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(history.getByText('Sent to Development', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Show topics', exact: true }).click();
    await topics.getByRole('button', { name: /^General/ }).click();
    await expect(composer).toHaveValue('General draft');
    await expect(history.getByText('Sent to Development', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show topics', exact: true }).click();
    await topics.getByRole('button', { name: 'Create topic', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'New Topic', exact: true });
    await create.getByRole('textbox', { name: 'Topic name' }).fill('Design');
    await create.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(create).toHaveCount(0);
    await expect(topics.getByRole('button', { name: /^Design/ })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`forums-${width}.png`),
      animations: 'disabled',
    });
    await topics.getByRole('button', { name: 'Manage Design', exact: true }).click();
    // A focus refresh can arrive while the topic menu is open.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await topics.getByRole('menuitem', { name: 'Close topic', exact: true }).click();
    await expect(topics.getByRole('button', { name: /Design.*Closed topic/ })).toBeVisible();
    await topics.getByRole('button', { name: /Design.*Closed topic/ }).click();
    await expect(composer).toHaveJSProperty('readOnly', true);
    await page.getByRole('button', { name: 'Show topics', exact: true }).click();
    await topics.getByRole('button', { name: 'Manage Design', exact: true }).click();
    await topics.getByRole('menuitem', { name: 'Reopen topic', exact: true }).click();
    await topics.getByRole('button', { name: /^Design/ }).click();
    await expect(composer).toHaveJSProperty('readOnly', false);
    await page.getByRole('button', { name: 'Show topics', exact: true }).click();
    await topics.getByRole('button', { name: 'Manage Design', exact: true }).click();
    await topics.getByRole('menuitem', { name: 'Delete topic', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: 'Delete Topic', exact: true });
    await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(topics.getByRole('button', { name: /^Design/ })).toBeVisible();
    await topics.getByRole('button', { name: 'Manage Design', exact: true }).click();
    await topics.getByRole('menuitem', { name: 'Delete topic', exact: true }).click();
    await deletion.getByRole('button', { name: 'Delete Topic', exact: true }).click();
    await expect(deletion).toHaveCount(0);
    await expect(topics.getByRole('button', { name: /^Design/ })).toHaveCount(0);
    await expect(page.getByTestId('conversation-header')).toContainText('General');
  });

test('a forum link opens the target topic and highlights its message', async ({ page }) => {
  await openReady(page, '/?scenario=forums');
  await chatButton(page, /Alice Fixture/).click();
  const url = 'https://t.me/c/202/10/102';
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(url);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('link', { name: url, exact: true }).last().click();
  await expect(page.getByTestId('conversation-header')).toContainText('Development');
  await expect(page.locator('article[data-message-id="102"]')).toContainText(
    'Development message 2',
  );
  await expect(page.locator('article[data-message-id="102"]')).toHaveClass(/message-target/);
  await expect(page.getByTestId('message-scroller').getByText(/^General message/)).toHaveCount(0);
  await expect(page).toHaveURL(/topic=10/);
  await page.reload();
  await expect(page.getByTestId('conversation-header')).toContainText('Development');
  await page.getByRole('button', { name: 'Search messages', exact: true }).click();
  const search = page.locator('.search-panel');
  await search.getByRole('searchbox', { name: 'Message search query' }).fill('message');
  await search.getByRole('searchbox', { name: 'Message search query' }).press('Enter');
  await expect(search.locator('.search-results')).toContainText('Development message');
  await expect(search.locator('.search-results')).not.toContainText('General message');
  await search.getByRole('button', { name: 'In: Development', exact: true }).click();
  await expect(search.locator('.search-results')).toContainText('General message');
  await search.locator('.search-results').getByText('General message 119', { exact: true }).click();
  await expect(page.getByTestId('conversation-header')).toContainText('General');
  await expect(page.locator('article[data-message-id="219"]')).toHaveClass(/message-target/);
});
