import { test } from '@playwright/test';
import { expect } from './expect';

import { chatButton, fixtureStats, openReady, selectAlice } from './helpers';

test('lays out, grows and edits the composer draft', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('centers the single-line composer label with its controls', async () => {
    const input = page.getByRole('textbox', { name: 'Message' });
    const emoji = page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' });
    const send = page.getByRole('button', { name: 'Send message' });
    const textCenter = await input.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.top + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.lineHeight) / 2
      );
    });
    const controlCenter = await emoji.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    const sendCenter = await send.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    expect(Math.abs(textCenter - controlCenter)).toBeLessThan(1);
    expect(Math.abs(sendCenter - controlCenter)).toBeLessThan(1);
  });
  await test.step('stays at the present edge whenever the composer adds a line', async () => {
    const input = page.getByRole('textbox', { name: 'Message' });
    const scroller = page.getByTestId('message-scroller');
    const distanceFromPresent = () =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      );
    await expect.poll(distanceFromPresent).toBeLessThan(0.5);
    await scroller.evaluate((element) => {
      const distances: number[] = [];
      const jumpVisibility: boolean[] = [];
      let sampling = true;
      const sample = () => {
        if (!sampling) return;
        distances.push(element.scrollHeight - element.scrollTop - element.clientHeight);
        jumpVisibility.push(Boolean(document.querySelector('.jump-to-present')));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      Object.assign(window, {
        __composerGrowthFrames: distances,
        __composerJumpFrames: jumpVisibility,
        __stopComposerGrowthFrames: () => {
          sampling = false;
        },
      });
    });

    for (let line = 1; line <= 6; line += 1) {
      await input.fill(Array.from({ length: line }, () => 'line').join('\n'));
      await expect.poll(distanceFromPresent).toBeLessThan(0.5);
    }
    await input.clear();
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const frameDistances = await page.evaluate(() => {
      const tracked = window as unknown as {
        __composerGrowthFrames: number[];
        __composerJumpFrames: boolean[];
        __stopComposerGrowthFrames: () => void;
      };
      tracked.__stopComposerGrowthFrames();
      return {
        distances: tracked.__composerGrowthFrames,
        jumpVisibility: tracked.__composerJumpFrames,
      };
    });
    expect(frameDistances.distances.length).toBeGreaterThan(0);
    expect(Math.max(...frameDistances.distances.map(Math.abs))).toBeLessThan(0.5);
    expect(frameDistances.jumpVisibility).not.toContain(true);
  });
  await test.step('grows multiline drafts, caps their height, and collapses after clearing', async () => {
    const input = page.getByRole('textbox', { name: 'Message' });
    const singleLineHeight = await input.evaluate((element) => element.clientHeight);

    await input.fill(Array.from({ length: 6 }, (_, index) => `Line ${index + 1}`).join('\n'));
    await expect
      .poll(() => input.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(singleLineHeight);

    await input.fill(Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join('\n'));
    const capped = await input.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(capped.scrollHeight).toBeGreaterThan(capped.clientHeight);
    expect(capped.overflowY).toBe('auto');

    await input.clear();
    await expect
      .poll(() => input.evaluate((element) => element.clientHeight))
      .toBe(singleLineHeight);
  });
  await test.step('wraps an unbroken draft without pushing composer controls off screen', async () => {
    const input = page.getByRole('textbox', { name: 'Message' });
    const send = page.getByRole('button', { name: 'Send message' });
    await input.fill('ы'.repeat(300));

    const layout = await page.locator('.chat-composer').evaluate((composer) => {
      const inputBox = composer.querySelector('textarea')!.getBoundingClientRect();
      const sendBox = composer
        .querySelector<HTMLButtonElement>('.send-button')!
        .getBoundingClientRect();
      return {
        composer: composer.getBoundingClientRect(),
        input: inputBox,
        send: sendBox,
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

    expect(layout.input.width).toBeLessThan(layout.composer.width);
    expect(layout.send.right).toBeLessThanOrEqual(layout.composer.right);
    expect(layout.send.left).toBeGreaterThanOrEqual(layout.composer.left);
    expect(layout.documentOverflow).toBe(0);
    await expect(send).toBeVisible();
  });
  await page.getByRole('textbox', { name: 'Message' }).clear();
  await test.step('edits the latest outgoing message with Up from an empty composer', async () => {
    const input = page.getByRole('textbox', { name: 'Message' });

    await input.fill('Keep this draft');
    await input.press('ArrowUp');
    await expect(page.getByTestId('composer-edit')).toHaveCount(0);
    await expect(input).toHaveValue('Keep this draft');

    await input.clear();
    await input.press('ArrowUp');
    await expect(page.getByTestId('composer-edit')).toBeVisible();
    await expect(input).toHaveValue('Newest message from fixture');
    await expect(input).toBeFocused();

    await input.press('Escape');
    await expect(page.getByTestId('composer-edit')).toHaveCount(0);
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
  });
  await test.step('does not send whitespace or submit while an IME composition is active', async () => {
    const input = page.getByRole('textbox', { name: 'Message' });
    const sendsBefore = (await fixtureStats(page))?.sendText;
    await input.fill('   ');
    await input.press('Enter');
    await expect(input).toHaveValue('   ');
    expect((await fixtureStats(page))?.sendText).toBe(sendsBefore);

    await input.fill('composing');
    await input.evaluate((element) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' });
      Object.defineProperty(event, 'isComposing', { value: true });
      element.dispatchEvent(event);
    });
    await expect(input).toHaveValue('composing');
    expect((await fixtureStats(page))?.sendText).toBe(sendsBefore);
  });
  await page.getByRole('textbox', { name: 'Message' }).clear();
  await test.step('moves keyboard focus into the expression picker and restores it on Escape', async () => {
    const trigger = page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' });
    await trigger.focus();
    await trigger.press('Enter');
    await expect(page.getByRole('searchbox', { name: 'Search expressions' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });
  await test.step('shows incoming typing and uploading activity', async () => {
    await page.evaluate(() =>
      window.__televechaFixture?.emit({
        type: 'activity',
        activity: { peerId: 'u:101', senderId: 'u:101', kind: 'typing' },
      }),
    );
    await expect(page.locator('.chat-header').getByRole('status')).toHaveText('typing…');
    await page.evaluate(() =>
      window.__televechaFixture?.emit({
        type: 'activity',
        activity: { peerId: 'u:101', senderId: 'u:101', kind: 'uploading' },
      }),
    );
    await expect(page.getByText('uploading…', { exact: true })).toBeVisible();
    await expect(page.locator('.activity-bar')).toHaveCount(0);
  });
  await test.step('keeps the jump-to-present control above a growing composer', async () => {
    const scroller = page.getByTestId('message-scroller');
    await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      element.scrollTop = 0;
    });
    const jump = page.getByRole('button', { name: 'Jump to present' });
    await expect(jump).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Message' })
      .fill(Array.from({ length: 6 }, (_, index) => `Line ${index + 1}`).join('\n'));

    const positions = await page.locator('.message-scroll-shell').evaluate((shell) => {
      const scrollerBox = shell
        .querySelector('[data-testid="message-scroller"]')!
        .getBoundingClientRect();
      const jumpBox = shell.querySelector('.jump-to-present')!.getBoundingClientRect();
      return { scrollerBottom: scrollerBox.bottom, jumpBottom: jumpBox.bottom };
    });
    expect(positions.jumpBottom).toBeLessThanOrEqual(positions.scrollerBottom);
  });
});

test('reports typing, sends formatted text and sends from the expression pickers', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  await test.step('throttles outgoing typing updates and sends a cancellation', async () => {
    const input = page.getByRole('textbox', { name: 'Message' });
    await input.pressSequentially('typing quickly', { delay: 5 });
    expect((await fixtureStats(page))?.setTyping).toBe(1);
    await input.clear();
    expect((await fixtureStats(page))?.setTyping).toBe(2);
  });
  await test.step('sends selected formatting, links, spoilers, and quotes', async () => {
    const input = page.getByRole('textbox', { name: 'Message' });
    await input.fill('bold link spoiler quote');
    const select = async (start: number, end: number) =>
      input.evaluate(
        (element, range) => {
          const textarea = element as HTMLTextAreaElement;
          textarea.focus();
          textarea.setSelectionRange(range.start, range.end);
        },
        { start, end },
      );
    const format = async (name: string) => {
      await input.dispatchEvent('contextmenu', { clientX: 420, clientY: 520 });
      await page
        .getByRole('menu', { name: 'Message formatting' })
        .getByRole('menuitem', { name })
        .click();
    };
    await select(0, 4);
    await format('Bold');
    await select(5, 9);
    page.once('dialog', (dialog) => void dialog.accept('https://example.com/formatted'));
    await format('Create link');
    await select(10, 17);
    await format('Spoiler');
    await select(18, 23);
    await format('Quote');
    await page.getByRole('button', { name: 'Send message' }).click();
    const sent = page.locator('article.message').last();
    await expect(sent.locator('.bold')).toHaveText('bold');
    await expect(sent.getByRole('link', { name: 'link' })).toHaveAttribute(
      'href',
      'https://example.com/formatted',
    );
    await expect(sent.locator('.spoiler')).toHaveText('spoiler');
    await expect(sent.locator('.blockquote')).toHaveText('quote');
  });
  await test.step('opens emoji, GIF, and sticker pickers and sends from each', async () => {
    const trigger = page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' });
    await trigger.click();
    await page.getByRole('button', { name: 'Insert 😀' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('😀');
    await trigger.click();
    const picker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
    await picker.getByRole('button', { name: 'GIFs' }).click();
    await page.getByLabel('GIFs').getByRole('button', { name: 'Send GIF' }).click();
    expect((await fixtureStats(page))?.getSavedGifs).toBe(1);
    await trigger.click();
    await page
      .getByRole('dialog', { name: 'Emoji, GIFs and stickers' })
      .getByRole('button', { name: 'Stickers' })
      .click();
    await expect(page.getByLabel('Stickers', { exact: true })).toBeVisible();
  });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

test('restores persisted drafts on entry without mirroring later snapshot changes into the composer', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  const composer = page.getByRole('textbox', { name: 'Message' });
  await page.evaluate(async () => {
    const runtime = window.__televechaRuntimes!.get('fixture:default')!;
    await runtime.runEffect(runtime.engine.setDraft('u:101', 'Persisted draft'));
  });
  await expect(composer).toHaveValue('');
  await chatButton(page, /Release Channel/).click();
  await chatButton(page, /Alice Fixture/).click();
  await expect(composer).toHaveValue('Persisted draft');
  await composer.fill('Local draft survives');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__televechaRuntimes!.get('fixture:default')!.engine.snapshot().drafts['u:101'],
      ),
    )
    .toBe('Local draft survives');
  // The snapshot changes before the draft reaches the device store. Draft writes are
  // serialized per chat, so awaiting one more write means the earlier ones are stored.
  await page.evaluate(async () => {
    const runtime = window.__televechaRuntimes!.get('fixture:default')!;
    await runtime.runEffect(runtime.engine.setDraft('u:101', 'Local draft survives'));
  });
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Local draft survives');
});

test('searches the full emoji set and sticker packs without redownloading cached assets', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  const trigger = page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
  await picker.getByPlaceholder('Search emoji').fill('animal');
  await expect(picker.getByRole('button', { name: 'Insert 🐶' })).toBeVisible();
  expect(await picker.locator('.emoji-grid button').count()).toBeGreaterThan(50);

  await picker.getByRole('button', { name: 'Stickers' }).click();
  await expect(picker.getByRole('button', { name: 'Fixture Animals' })).toBeVisible();
  await picker.getByPlaceholder('Search stickers').fill('animated');
  await expect(picker.getByRole('button', { name: 'Send ✨ sticker' })).toBeVisible();
  await expect
    .poll(async () => (await fixtureStats(page))?.downloadSticker ?? 0)
    .toBeGreaterThan(0);
  const downloads = (await fixtureStats(page))?.downloadSticker;
  await page.keyboard.press('Escape');
  await expect(picker.getByPlaceholder('Search stickers')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await trigger.click();
  await picker.getByRole('button', { name: 'Stickers' }).click();
  await page.waitForTimeout(100);
  expect((await fixtureStats(page))?.downloadSticker).toBe(downloads);
});

test('searches Telegram for GIFs instead of filtering saved GIF identifiers', async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
  await page.getByRole('button', { name: 'Choose emoji, GIF, or sticker' }).click();
  const picker = page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' });
  await picker.getByRole('button', { name: 'GIFs' }).click();
  await picker.getByPlaceholder('Search gifs').fill('cat');
  await expect(picker.getByRole('button', { name: 'Send GIF cat result' })).toBeVisible();
  expect((await fixtureStats(page))?.searchGifs).toBe(1);
});

test('keeps the reading position when a multiline draft grows in older history', async ({
  page,
}) => {
  await openReady(page);
  await selectAlice(page);
  const scroller = page.getByTestId('message-scroller');
  await scroller.evaluate((element) => {
    element.scrollTop -= 280;
  });
  await expect(page.getByRole('button', { name: 'Jump to present', exact: true })).toBeVisible();
  const anchor = await scroller.evaluate((element) => {
    const viewportTop = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>('article[data-message-id]')].find(
      (item) => item.getBoundingClientRect().top >= viewportTop,
    )!;
    return { id: row.dataset.messageId!, top: row.getBoundingClientRect().top };
  });
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('First line\nSecond line\nThird line\nFourth line\nFifth line');
  await expect
    .poll(() =>
      page
        .locator(`article[data-message-id="${anchor.id}"]`)
        .evaluate(
          (element, top) => Math.abs(element.getBoundingClientRect().top - top),
          anchor.top,
        ),
    )
    .toBeLessThan(1);
  await expect(page.getByRole('button', { name: 'Jump to present', exact: true })).toBeVisible();
});
