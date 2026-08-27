import { expect, test } from '@playwright/test';

import { fixtureStats, openReady, selectAlice } from './helpers';

test.beforeEach(async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
});

test('shows a forwarded source and opens its original post', async ({ page }) => {
  const forwarded = page
    .locator('article[data-message-id="73"]')
    .getByRole('button', { name: 'Forwarded from Release Channel' });
  await expect(forwarded).toBeVisible();
  await forwarded.click();

  await expect(page.locator('article[data-message-id="5"]')).toHaveClass(/message-target/);
  await expect(page.getByRole('heading', { name: 'Release Channel' })).toBeVisible();
});

async function openStickers(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' }).click();
  const expressionPicker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
  await expressionPicker.getByRole('button', { name: 'Stickers' }).click();
  return expressionPicker.getByLabel('Stickers');
}

test('adds and removes a Telegram reaction optimistically', async ({ page }) => {
  const message = page.locator('article[data-message-id="79"]');
  await message.getByRole('button', { name: 'Add 👍 reaction' }).click();
  await expect(message.getByRole('button', { name: 'Remove 👍 reaction' })).toContainText('3');
  expect((await fixtureStats(page))?.setReaction).toBe(1);

  await message.getByRole('button', { name: 'Remove 👍 reaction' }).click();
  await expect(message.getByRole('button', { name: 'Add 👍 reaction' })).toContainText('2');
  expect((await fixtureStats(page))?.setReaction).toBe(2);
});

test('chooses a new reaction from the message reaction picker', async ({ page }) => {
  const message = page.locator('article[data-message-id="80"]');
  await message.hover();
  await message.getByRole('button', { name: 'React to message 80' }).click();
  await page
    .getByRole('dialog', { name: 'Choose reaction' })
    .getByRole('button', {
      name: 'React with 🔥',
    })
    .click();

  await expect(message.getByRole('button', { name: 'Remove 🔥 reaction' })).toContainText('1');
  expect((await fixtureStats(page))?.setReaction).toBe(1);
});

test('renders and toggles a Telegram custom-emoji reaction', async ({ page }) => {
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'reaction-changed',
      peerId: 'u:101',
      messageId: 79,
      reactions: [{ emoji: 'custom:99', customEmojiId: '99', count: 2, chosen: false }],
    }),
  );
  const message = page.locator('article[data-message-id="79"]');
  const reaction = message.getByRole('button', { name: 'Add custom emoji reaction' });
  await expect(reaction.locator('img')).toBeVisible();
  await reaction.click();
  await expect(message.getByRole('button', { name: 'Remove custom emoji reaction' })).toContainText(
    '3',
  );
});

test('opens recent stickers, previews them, and sends the selected sticker', async ({ page }) => {
  const picker = await openStickers(page);
  await expect(picker).toBeVisible();
  await expect(picker.locator('img').first()).toBeVisible();
  await expect(picker.getByRole('img', { name: '✨ animated sticker' })).toBeVisible();
  await picker.getByRole('button', { name: 'Send 👍 sticker' }).click();

  await expect(page.locator('article[data-media-kind="sticker"]').last()).toBeVisible();
  const stats = await fixtureStats(page);
  expect(stats?.getRecentStickers).toBe(1);
  expect(stats?.getStickerPacks).toBe(1);
  expect(stats?.downloadSticker).toBe(3);
  expect(stats?.sendSticker).toBe(1);
});

test('sends and plays an animated TGS sticker', async ({ page }) => {
  const picker = await openStickers(page);
  await picker.getByRole('button', { name: 'Send ✨ sticker' }).click();

  const sent = page.locator('article[data-media-kind="sticker"]').last();
  await expect(sent.getByRole('img', { name: 'sticker-sticker-3.tgs' })).toBeVisible();
  await expect(sent.locator('.tgs-player')).not.toHaveAttribute('data-error', 'true');
});

test('navigates every installed sticker pack', async ({ page }) => {
  const picker = await openStickers(page);
  const recent = picker.getByRole('button', { name: 'Recent' });
  await expect(recent).toBeVisible();
  await expect(recent.locator('svg')).toBeVisible();
  await expect(recent.locator('img, video, .tgs-player')).toHaveCount(0);
  await expect(picker.getByRole('button', { name: 'Fixture Animals' })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Fixture Animated' })).toBeVisible();
  await picker.getByRole('button', { name: 'Fixture Animated' }).click();
  await expect(picker.getByLabel('Fixture Animated').getByRole('button')).toHaveCount(1);
});

test('uploads a pasted clipboard image through the attachment path', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Message' }).evaluate((textarea) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['clipboard'], '', { type: 'image/png' }));
    textarea.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  });

  await expect(page.getByTestId('composer-attachment')).toContainText('pasted-image-');
  expect((await fixtureStats(page))?.sendFile).toBe(0);
  await page.getByRole('textbox', { name: 'Message' }).fill('Pasted caption');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(async () => (await fixtureStats(page))?.sendFile).toBe(1);
  await expect(page.locator('article.message').last()).toContainText('Pasted caption');
  await expect(page.locator('article.message').last().locator('img')).toBeVisible();
});

test('uploads a file dropped onto the composer', async ({ page }) => {
  await page.locator('.composer').evaluate((composer) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['drop'], 'dropped.png', { type: 'image/png' }));
    composer.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });

  await expect(page.getByTestId('composer-attachment')).toContainText('dropped.png');
  expect((await fixtureStats(page))?.sendFile).toBe(0);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(async () => (await fixtureStats(page))?.sendFile).toBe(1);
  await expect(page.locator('article.message').last()).toContainText('dropped.png');
  await expect(page.locator('article.message').last().getByRole('img')).toBeVisible();
});

test('removes a staged attachment without sending it', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles('e2e/fixtures/report.txt');
  await expect(page.getByTestId('composer-attachment')).toContainText('report.txt');
  await page.getByRole('button', { name: 'Remove attachment' }).click();
  await expect(page.getByTestId('composer-attachment')).toHaveCount(0);
  expect((await fixtureStats(page))?.sendFile).toBe(0);
});

test('preserves the pending bubble DOM node when Telegram confirms the send', async ({ page }) => {
  await page.goto('/?scenario=held-upload');
  await selectAlice(page);
  await page.getByRole('textbox', { name: 'Message' }).fill('Stable upload');
  await page.locator('input[type="file"]').setInputFiles('e2e/fixtures/report.txt');
  await page.getByRole('button', { name: 'Send message' }).click();
  const pending = page.locator('article.message', { hasText: 'Stable upload' });
  await pending.evaluate((element) => {
    element.dataset.pendingNode = 'preserve';
  });

  await page.evaluate(() => window.__televechaFixture?.releaseUpload());
  await expect(pending).toHaveAttribute('data-pending-node', 'preserve');
  await expect(pending.locator('footer')).toHaveAttribute('aria-label', /Message status: sent$/u);
});

test('confirms a text send atomically without removing or replacing its bubble', async ({
  page,
}) => {
  await page.goto('/?scenario=held-send');
  await selectAlice(page);
  await page.getByRole('textbox', { name: 'Message' }).fill('Stable text send');
  await page.getByRole('button', { name: 'Send message' }).click();
  const pending = page.locator('article.message', { hasText: 'Stable text send' });
  await expect(pending.locator('footer')).toHaveAttribute(
    'aria-label',
    /Message status: sending$/u,
  );
  await pending.evaluate((element) => {
    element.dataset.pendingNode = 'preserve-text';
  });

  await page.evaluate(() => window.__televechaFixture?.releaseSend());
  await expect(pending).toHaveAttribute('data-pending-node', 'preserve-text');
  await expect(pending.locator('footer')).toHaveAttribute('aria-label', /Message status: sent$/u);
});

test('sends a whole-message reply and renders its reply preview', async ({ page }) => {
  const source = page.locator('article[data-message-id="79"]');
  await source.hover();
  await source.getByRole('button', { name: 'Reply to message 79' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused();
  await expect(page.getByTestId('composer-reply')).toContainText('Reply');
  await expect(page.getByTestId('composer-reply')).toContainText('Fixture message 79');
  await expect(page.getByTestId('composer-reply')).not.toHaveCSS(
    'background-color',
    'rgb(25, 28, 34)',
  );

  await page.getByRole('textbox', { name: 'Message' }).fill('Reply body');
  await page.getByRole('button', { name: 'Send message' }).click();
  const reply = page.locator('article.message').last();
  await expect(reply.getByRole('button', { name: /Jump/ })).toHaveText('Fixture message 79');
  await expect(reply).toHaveClass(/message-inline-time/u);
  const inlineTime = await reply.evaluate((element) => {
    const body = element.querySelector<HTMLElement>('.message-body')!;
    const footer = element.querySelector<HTMLElement>('footer')!;
    const range = document.createRange();
    range.selectNodeContents(body);
    const text = [...range.getClientRects()].at(-1)!;
    const time = footer.getBoundingClientRect();
    return {
      bodyDisplay: getComputedStyle(body).display,
      horizontalGap: time.left - text.right,
      verticalOverlap: Math.min(text.bottom, time.bottom) - Math.max(text.top, time.top),
    };
  });
  expect(inlineTime.bodyDisplay).toBe('inline');
  expect(inlineTime.horizontalGap).toBeGreaterThan(4);
  expect(inlineTime.verticalOverlap).toBeGreaterThan(0);
});

test('cancels a composer reply without changing the draft', async ({ page }) => {
  const source = page.locator('article[data-message-id="79"]');
  await source.getByRole('button', { name: 'Reply to message 79' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Cancel reply' }).click();

  await expect(page.getByTestId('composer-reply')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft');
});

test('replies with the selected part of a message as a Telegram quote', async ({ page }) => {
  const source = page.locator('article[data-message-id="76"]');
  await source.evaluate((article) => {
    const body = article.querySelector('.message-body');
    if (!body) throw new Error('Message body is missing');
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let start: { node: Node; offset: number } | undefined;
    let consumed = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent ?? '';
      const index = (body.textContent ?? '').indexOf('bold italic');
      if (!start && index >= consumed && index < consumed + text.length) {
        start = { node, offset: index - consumed };
      }
      if (start && index + 'bold italic'.length <= consumed + text.length) {
        range.setStart(start.node, start.offset);
        range.setEnd(node, index + 'bold italic'.length - consumed);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      consumed += text.length;
    }
    throw new Error('Quote text was not found');
  });
  await source.getByRole('button', { name: 'Reply to message 76' }).click();
  await expect(page.getByTestId('composer-reply')).toContainText('Reply with quote');
  await expect(page.getByTestId('composer-reply')).toContainText('bold italic');

  await page.getByRole('textbox', { name: 'Message' }).fill('Quoted reply');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page.locator('article.message').last().getByRole('button', { name: /Jump/ }),
  ).toHaveText('bold italic');
});

test('renders mentions, links, previews, wrapping, formatting, and spoilers', async ({ page }) => {
  const message = page.locator('article[data-message-id="76"]');
  await expect(message.locator('.mention')).toHaveText('@alice');
  await expect(message.getByRole('link', { name: /https:\/\/example.com/ })).toHaveAttribute(
    'href',
    'https://example.com/a/very/long/link',
  );
  await expect(message.getByRole('link', { name: /Fixture link preview/ })).toContainText(
    'Telegram supplied this preview description.',
  );
  await expect(message.locator('.link-preview img')).toBeVisible();
  await expect(page.locator('article[data-message-id="77"] .message-reply')).not.toHaveCSS(
    'color',
    'rgb(139, 144, 154)',
  );
  const renderedReply = page.locator('article[data-message-id="77"] .message-reply');
  await expect(renderedReply).toHaveCSS('border-left-width', '0px');
  await expect(renderedReply).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(message.locator('.bold')).toHaveCSS('font-weight', '700');
  await expect(message.locator('.italic')).toHaveCSS('font-style', 'italic');
  const spoiler = message.locator('.spoiler');
  await expect(spoiler).toHaveAttribute('role', 'button');
  await expect(spoiler).toHaveAttribute('aria-expanded', 'false');
  await expect(spoiler).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  await spoiler.focus();
  await spoiler.press('Enter');
  await expect(spoiler).toHaveAttribute('aria-expanded', 'true');
  await expect(spoiler).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  expect(
    await message.locator('.message-body').evaluate((body) => body.scrollWidth <= body.clientWidth),
  ).toBe(true);
});

test('renders bot Rich Markdown blocks and nested formatting', async ({ page }) => {
  const rich = page.locator('article[data-message-id="74"] .rich-message');
  await expect(rich.getByRole('heading', { name: 'Rich Markdown' })).toBeVisible();
  await expect(rich.locator('mark')).toHaveText('Highlighted');
  await expect(rich.getByRole('checkbox', { name: 'Completed' })).toBeChecked();
  await expect(rich.getByRole('columnheader', { name: 'Feature' })).toBeVisible();
  await expect(rich.getByRole('cell', { name: 'Status' })).toBeVisible();

  const spoiler = rich.locator('.rich-spoiler');
  await expect(spoiler).toHaveAccessibleName('Hidden spoiler. Activate to reveal.');
  await expect(spoiler).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  await spoiler.click();
  await expect(spoiler).toHaveAttribute('aria-expanded', 'true');

  await rich.getByText('More').click();
  await expect(rich.getByText('Nested content')).toBeVisible();
});
