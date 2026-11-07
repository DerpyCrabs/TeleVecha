import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, selectAlice } from './helpers';

test('opens a public post internally from text, shows paginated comments and returns to the post', async ({
  page,
  context,
}) => {
  await openReady(page, '/?scenario=comments');
  await selectAlice(page);
  await page
    .getByRole('link', { name: 'https://t.me/public_fixture_news/965', exact: true })
    .click();
  await expect(page.getByTestId('conversation-header')).toContainText('Public Fixture News');
  const post = page.locator('article.message[data-message-id="965"]');
  await expect(post).toContainText('Public post 965');
  await post.getByRole('button', { name: '75 comments' }).click();
  const panel = page.getByRole('dialog', { name: 'Comments', exact: true });
  await expect(panel.getByText('Fixture comment 75', { exact: true })).toBeVisible();
  await expect(panel.getByText('Public post 965', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('Fixture comment 1', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Load older comments' }).click();
  await expect(panel.getByText('Fixture comment 1', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Load older comments' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Back to post' }).click();
  await expect(panel).toHaveCount(0);
  await expect(post).toBeVisible();
  expect(context.pages()).toHaveLength(1);
});

test('opens a preview internally and handles empty or unavailable discussions', async ({
  page,
}) => {
  await openReady(page, '/?scenario=comments');
  await selectAlice(page);
  await page.locator('a[href="https://t.me/public_fixture_news/965"]').last().click();
  await expect(page.getByTestId('conversation-header')).toContainText('Public Fixture News');
  await page
    .locator('article.message[data-message-id="967"]')
    .getByRole('button', { name: 'View comments' })
    .click();
  await expect(page.getByText('No comments yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to post' }).click();
  await page
    .locator('article.message[data-message-id="966"]')
    .getByRole('button', { name: 'View comments' })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Comments', exact: true }).getByRole('alert'),
  ).toContainText('unavailable');
});

test('opens a specific comment and rejects a missing post without inserting a fake message', async ({
  page,
}) => {
  await openReady(page, '/?scenario=comments');
  await selectAlice(page);
  const link = page.getByRole('link', {
    name: 'https://t.me/public_fixture_news/965',
    exact: true,
  });
  await link.evaluate((node) =>
    node.setAttribute('href', 'https://t.me/public_fixture_news/965?comment=100'),
  );
  await link.click();
  await expect(page.locator('[data-comment-id="100"]')).toBeVisible();
  await page.getByRole('button', { name: 'Back to post' }).click();
  await selectAlice(page);
  await link.evaluate((node) => node.setAttribute('href', 'https://t.me/public_fixture_news/999'));
  await link.click();
  await expect(
    page.getByText('This post was deleted or is unavailable.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('article.message[data-message-id="999"]')).toHaveCount(0);
});

test('works on a narrow screen and retries a failed comment request', async ({ page }) => {
  await openReady(page, '/?scenario=comments-fail-once&chat=u:101');
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('link', { name: 'https://t.me/public_fixture_news/965', exact: true })
    .click();
  await page
    .locator('article.message[data-message-id="965"]')
    .getByRole('button', { name: '75 comments' })
    .click();
  const panel = page.getByRole('dialog', { name: 'Comments', exact: true });
  await expect(panel.getByRole('alert')).toContainText('Could not load comments.');
  await panel.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(panel.getByText('Fixture comment 26', { exact: true })).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  const box = await panel.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  await panel.getByRole('button', { name: 'Back to post' }).click();
  await expect(page.getByTestId('conversation-header')).toContainText('Public Fixture News');
});

test('channel preview stays out of the chat list after message updates and reload', async ({
  page,
}) => {
  await openReady(page, '/?scenario=comments');
  await selectAlice(page);
  await page
    .getByRole('link', { name: 'https://t.me/public_fixture_news/965', exact: true })
    .click();
  await expect(page.getByTestId('conversation-header')).toContainText('Public Fixture News');
  const chat = page.getByTestId('chat-list').getByRole('button', { name: /Public Fixture News/ });
  await expect(chat).toHaveCount(0);
  for (const [type, id, pts] of [
    ['edit-message', 965, 11],
    ['new-message', 968, 12],
  ] as const) {
    await page.evaluate(
      ({ type, id, pts }) =>
        window.__televechaFixture?.emit({
          type,
          pts,
          ptsCount: 1,
          channelScoped: true,
          message: {
            id,
            peerId: 'c:707',
            senderId: 'c:707',
            text: `Preview update ${id}`,
            date: 1_700_002_000,
            outgoing: false,
          },
        }),
      { type, id, pts },
    );
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            [...(window.__televechaRuntimes?.values() ?? [])][0]?.engine
              .snapshot()
              .messages.some(
                (message) => message.id === id && message.text === `Preview update ${id}`,
              ),
          id,
        ),
      )
      .toBe(true);
    await expect(chat).toHaveCount(0);
  }
  await selectAlice(page);
  await expect(chat).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('conversation-header')).toContainText('Alice Fixture');
  await expect(chat).toHaveCount(0);
  await expect(
    page.getByTestId('chat-list').getByRole('button', { name: /Release Channel/ }),
  ).toBeVisible();
});

test('updates open discussions without a refresh button and retains loaded older comments', async ({
  page,
}) => {
  await openReady(page, '/?scenario=comments&chat=u:101');
  await page
    .getByRole('link', { name: 'https://t.me/public_fixture_news/965', exact: true })
    .click();
  await page.getByRole('button', { name: '75 comments' }).click();
  const panel = page.getByRole('dialog', { name: 'Comments', exact: true });
  await panel.getByRole('button', { name: 'Load older comments' }).click();
  await expect(panel.locator('[data-comment-id="100"]')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: /Refresh/ })).toHaveCount(0);
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 175,
        peerId: 'c:909',
        senderId: 'u:101',
        text: 'Live comment',
        date: 1_700_002_000,
        outgoing: false,
        replyToId: 174,
      },
    }),
  );
  await expect(panel.locator('[data-comment-id="175"]')).toContainText('Live comment');
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'edit-message',
      pts: 12,
      ptsCount: 1,
      message: {
        id: 175,
        peerId: 'c:909',
        senderId: 'u:101',
        text: 'Edited comment',
        date: 1_700_002_000,
        outgoing: false,
        replyToId: 174,
      },
    }),
  );
  await expect(panel.locator('[data-comment-id="175"]')).toContainText('Edited comment');
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'delete-messages',
      pts: 13,
      ptsCount: 1,
      peerId: 'c:909',
      messageIds: [175],
    }),
  );
  await expect(panel.locator('[data-comment-id="175"]')).toHaveCount(0);
  await expect(panel.locator('[data-comment-id="100"]')).toHaveCount(1);
});

for (const width of [375, 768, 1280]) {
  test(`comments show author avatars and compact timestamps at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openReady(page, '/?scenario=comments&chat=u:101');
    await page.setViewportSize({ width, height: 800 });
    await page
      .getByRole('link', { name: 'https://t.me/public_fixture_news/965', exact: true })
      .click();
    await page.getByRole('button', { name: '75 comments' }).click();
    const panel = page.getByRole('dialog', { name: 'Comments', exact: true });
    const first = panel.locator('[data-comment-id]').first();
    await expect(first.locator('[data-avatar-identity]')).toBeVisible();
    await expect(first.locator('.comment-avatar')).toHaveAttribute('title', 'Alice Fixture');
    await expect(first.locator('time')).toHaveAttribute('datetime', /2023-/);
    await expect(first.locator('time')).toHaveAttribute('title', /2023/);
    const geometry = await panel.evaluate((element) => ({
      width: element.scrollWidth,
      client: element.clientWidth,
    }));
    expect(geometry.width).toBeLessThanOrEqual(geometry.client);
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('comment-avatars.png'),
    });
  });
}
