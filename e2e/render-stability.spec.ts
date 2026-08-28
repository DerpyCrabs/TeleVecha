import { expect, type Locator, test } from '@playwright/test';

import { chatButton, fixtureStats, openReady, selectAlice } from './helpers';

async function mark(locator: Locator, value: string) {
  await locator.evaluate(
    (element, marker) => element.setAttribute('data-ux-marker', marker),
    value,
  );
}

async function expectMarked(locator: Locator, value: string) {
  await expect(locator).toHaveAttribute('data-ux-marker', value);
}

async function waitForScrollToSettle(scroller: Locator) {
  await scroller.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        let previous = element.scrollTop;
        let stableFrames = 0;
        const check = () => {
          const current = element.scrollTop;
          stableFrames = Math.abs(current - previous) < 0.5 ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 3) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
  );
}

test.beforeEach(async ({ page }) => {
  await openReady(page);
  await selectAlice(page);
});

test('typing a draft does not replace messages, media, or unchanged chat rows', async ({
  page,
}) => {
  const bubble = page.locator('article[data-message-id="79"]');
  const image = page.getByRole('img', { name: 'fixture.jpg', exact: true });
  const release = chatButton(page, /Release Channel/);
  await mark(bubble, 'bubble');
  await mark(image, 'image');
  await mark(release, 'release');
  const imageSource = await image.getAttribute('src');
  const callsBefore = await fixtureStats(page);

  await page.getByRole('textbox', { name: 'Message' }).pressSequentially('draft text', {
    delay: 5,
  });

  await expectMarked(bubble, 'bubble');
  await expectMarked(image, 'image');
  await expectMarked(release, 'release');
  await expect(image).toHaveAttribute('src', imageSource ?? '');
  const callsAfter = await fixtureStats(page);
  expect(callsAfter?.getDialogs).toBe(callsBefore?.getDialogs);
  expect(callsAfter?.getHistory).toBe(callsBefore?.getHistory);
  expect(callsAfter?.downloadMedia).toBe(callsBefore?.downloadMedia);
});

test('typing does not nudge the conversation on each input', async ({ page }) => {
  const scroller = page.getByTestId('message-scroller');
  const composer = page.getByRole('textbox', { name: 'Message' });
  await waitForScrollToSettle(scroller);
  const initial = await scroller.evaluate((element) => element.scrollTop);
  await page.evaluate(() => {
    const scrollElement = document.querySelector<HTMLElement>('[data-testid="message-scroller"]');
    const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    if (!scrollElement || !input) throw new Error('Missing conversation controls');
    const positions: number[] = [];
    input.addEventListener('input', () => {
      requestAnimationFrame(() => positions.push(scrollElement.scrollTop));
    });
    Object.assign(window, { __draftScrollPositions: positions });
  });

  await composer.pressSequentially('one stable line', { delay: 10 });
  await page.waitForTimeout(50);
  const positions = await page.evaluate(
    () => (window as unknown as { __draftScrollPositions: number[] }).__draftScrollPositions,
  );

  expect(positions).toHaveLength('one stable line'.length);
  expect(Math.max(initial, ...positions) - Math.min(initial, ...positions)).toBeLessThan(0.5);
});

test('opening and closing details does not replace the conversation or image', async ({ page }) => {
  const bubble = page.locator('article[data-message-id="79"]');
  const image = page.getByRole('img', { name: 'fixture.jpg', exact: true });
  await mark(bubble, 'bubble');
  await mark(image, 'image');

  await page.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('button', { name: 'Open details' }).click();

  await expectMarked(bubble, 'bubble');
  await expectMarked(image, 'image');
});

test('a read receipt updates checkmarks without replacing the bubble or its image', async ({
  page,
}) => {
  const outgoingImageBubble = page.locator('article[data-message-id="78"]');
  const image = page.getByRole('img', { name: 'fixture.jpg', exact: true });
  const incomingBubble = page.locator('article[data-message-id="79"]');
  await mark(outgoingImageBubble, 'outgoing-image-bubble');
  await mark(image, 'image');
  await mark(incomingBubble, 'incoming-bubble');

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'read-history',
      pts: 11,
      ptsCount: 1,
      peerId: 'u:101',
      maxMessageId: 80,
      direction: 'outbox',
    }),
  );

  await expect(outgoingImageBubble.locator('footer')).toHaveAttribute(
    'aria-label',
    /Message status: read$/u,
  );
  await expectMarked(outgoingImageBubble, 'outgoing-image-bubble');
  await expectMarked(image, 'image');
  await expectMarked(incomingBubble, 'incoming-bubble');
});

test('an inactive-chat update preserves the open conversation and unchanged chat rows', async ({
  page,
}) => {
  const bubble = page.locator('article[data-message-id="79"]');
  const image = page.getByRole('img', { name: 'fixture.jpg', exact: true });
  const alice = chatButton(page, /Alice Fixture/);
  const release = chatButton(page, /Release Channel/);
  const aliceAvatar = alice.locator('img');
  await mark(bubble, 'bubble');
  await mark(image, 'image');
  await mark(alice, 'alice');
  await mark(release, 'release');
  await mark(aliceAvatar, 'alice-avatar');
  const callsBefore = await fixtureStats(page);

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 13,
        peerId: 'g:303',
        senderId: 'u:404',
        text: 'Background group update',
        date: 1_700_003_000,
        outgoing: false,
      },
    }),
  );
  await expect(chatButton(page, /Fixture Group/)).toContainText('Background group update');

  await expectMarked(bubble, 'bubble');
  await expectMarked(image, 'image');
  await expectMarked(alice, 'alice');
  await expectMarked(release, 'release');
  await expectMarked(aliceAvatar, 'alice-avatar');
  const callsAfter = await fixtureStats(page);
  expect(callsAfter?.getDialogs).toBe(callsBefore?.getDialogs);
  expect(callsAfter?.getHistory).toBe(callsBefore?.getHistory);
  expect(callsAfter?.downloadMedia).toBe(callsBefore?.downloadMedia);
});

test('a new active-chat message appends without replacing existing bubbles', async ({ page }) => {
  const oldBubble = page.locator('article[data-message-id="79"]');
  const image = page.getByRole('img', { name: 'fixture.jpg', exact: true });
  await mark(oldBubble, 'old-bubble');
  await mark(image, 'image');
  const callsBefore = await fixtureStats(page);

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Appended without refetch',
        date: 1_700_003_000,
        outgoing: false,
      },
    }),
  );
  await expect(page.locator('article[data-message-id="81"]')).toBeVisible();

  await expectMarked(oldBubble, 'old-bubble');
  await expectMarked(image, 'image');
  const callsAfter = await fixtureStats(page);
  expect(callsAfter?.getDialogs).toBe(callsBefore?.getDialogs);
  expect(callsAfter?.getHistory).toBe(callsBefore?.getHistory);
});

test('an incoming message does not move a viewport reading older messages', async ({ page }) => {
  const scroller = page.getByTestId('message-scroller');
  const anchor = await scroller.evaluate(
    (element) =>
      new Promise<{ id: string; top: number }>((resolve, reject) => {
        element.addEventListener(
          'scroll',
          () => {
            const top = element.getBoundingClientRect().top;
            const message = [...element.querySelectorAll<HTMLElement>('article.message')].find(
              (candidate) => candidate.getBoundingClientRect().bottom >= top,
            );
            if (!message?.dataset.messageId) {
              reject(new Error('Visible message anchor is missing'));
              return;
            }
            resolve({ id: message.dataset.messageId, top: message.getBoundingClientRect().top });
          },
          { once: true },
        );
        element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
        element.scrollTop = Math.max(200, element.scrollHeight - element.clientHeight - 600);
      }),
  );

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Incoming while reading history',
        date: 1_700_003_000,
        outgoing: false,
      },
    }),
  );

  const anchorAfter = page.locator(`article[data-message-id="${anchor.id}"]`);
  await expect
    .poll(async () =>
      Math.abs(
        (await anchorAfter.evaluate((element) => element.getBoundingClientRect().top)) - anchor.top,
      ),
    )
    .toBeLessThan(3);
});

test('keeps following the present through staggered message layout growth', async ({ page }) => {
  const scroller = page.getByTestId('message-scroller');
  const distanceFromPresent = () =>
    scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  await expect.poll(distanceFromPresent).toBeLessThan(3);

  await page.evaluate(async () => {
    const emit = (id: number, pts: number) =>
      window.__televechaFixture?.emit({
        type: 'new-message',
        pts,
        ptsCount: 1,
        message: {
          id,
          peerId: 'u:101',
          senderId: 'u:101',
          text: Array(20).fill(`Staggered layout ${id}`).join('\n'),
          date: 1_700_003_000 + id,
          outgoing: false,
        },
      });
    emit(181, 11);
    await new Promise((resolve) => setTimeout(resolve, 10));
    emit(182, 12);
  });

  await expect(page.locator('article[data-message-id="182"]')).toBeAttached();
  await expect.poll(distanceFromPresent).toBeLessThan(3);
});

test('a small upward wheel movement leaves present-follow mode', async ({ page }) => {
  const scroller = page.getByTestId('message-scroller');
  const distanceFromPresent = () =>
    scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  await expect.poll(distanceFromPresent).toBeLessThan(0.5);

  await scroller.hover();
  await page.mouse.wheel(0, -4);
  await expect.poll(distanceFromPresent).toBeGreaterThan(2);
  const readingDistance = await distanceFromPresent();

  await page.waitForTimeout(250);
  expect(await distanceFromPresent()).toBeCloseTo(readingDistance, 0);

  await page.mouse.wheel(0, 4);
  await expect.poll(distanceFromPresent).toBeLessThanOrEqual(2);
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 184,
        peerId: 'u:101',
        senderId: 'u:101',
        text: Array(12).fill('Message after returning to the present').join('\n'),
        date: 1_700_003_184,
        outgoing: false,
      },
    }),
  );
  await expect(page.locator('article[data-message-id="184"]')).toBeAttached();
  await expect.poll(distanceFromPresent).toBeLessThan(3);
});

test('replying and typing do not undo a small upward wheel movement', async ({ page }) => {
  const scroller = page.getByTestId('message-scroller');
  const distanceFromPresent = () =>
    scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  await expect.poll(distanceFromPresent).toBeLessThan(0.5);

  await scroller.hover();
  await page.mouse.wheel(0, -4);
  await expect.poll(distanceFromPresent).toBeGreaterThan(2);
  await page.waitForTimeout(250);

  const replyMessage = page.locator('article[data-message-id="79"]');
  await replyMessage.hover();
  await waitForScrollToSettle(scroller);
  const anchor = await scroller.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const message = [...element.querySelectorAll<HTMLElement>('article.message')].find(
      (candidate) => candidate.getBoundingClientRect().bottom >= top,
    );
    if (!message?.dataset.messageId) throw new Error('Visible message anchor is missing');
    return { id: message.dataset.messageId, top: message.getBoundingClientRect().top };
  });

  await replyMessage.getByRole('button', { name: 'Reply to message 79' }).click();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await expect(composer).toBeFocused();
  await composer.pressSequentially('Small-scroll draft', { delay: 5 });
  await page.waitForTimeout(250);

  const anchorMessage = page.locator(`article[data-message-id="${anchor.id}"]`);
  expect(
    Math.abs(
      (await anchorMessage.evaluate((element) => element.getBoundingClientRect().top)) - anchor.top,
    ),
  ).toBeLessThan(3);
  expect(await distanceFromPresent()).toBeGreaterThan(2);
});

test('replying and typing preserve the message being read above the present', async ({ page }) => {
  await page.evaluate(() => {
    for (let index = 0; index < 8; index += 1) {
      window.__televechaFixture?.emit({
        type: 'new-message',
        pts: 11 + index,
        ptsCount: 1,
        message: {
          id: 190 + index,
          peerId: 'u:101',
          senderId: 'u:101',
          text: Array(8).fill(`Reading anchor ${index}`).join('\n'),
          date: 1_700_004_000 + index,
          outgoing: false,
        },
      });
    }
  });
  const scroller = page.getByTestId('message-scroller');
  await expect(page.locator('article[data-message-id="197"]')).toBeAttached();
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(3);
  await scroller.hover();
  await page.mouse.wheel(0, -500);
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeGreaterThan(100);
  await waitForScrollToSettle(scroller);
  const anchorId = await scroller.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const message = [...element.querySelectorAll<HTMLElement>('article.message')].find(
      (candidate) => candidate.getBoundingClientRect().bottom >= top,
    );
    if (!message?.dataset.messageId) throw new Error('Visible message anchor is missing');
    return message.dataset.messageId;
  });

  const anchorMessage = page.locator(`article[data-message-id="${anchorId}"]`);
  await anchorMessage.hover();
  await waitForScrollToSettle(scroller);
  const anchorTop = await anchorMessage.evaluate((element) => element.getBoundingClientRect().top);
  await anchorMessage.getByRole('button', { name: `Reply to message ${anchorId}` }).click();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await expect(composer).toBeFocused();
  await composer.pressSequentially('Growing reply draft '.repeat(40), { delay: 1 });

  await expect
    .poll(async () =>
      Math.abs(
        (await anchorMessage.evaluate((element) => element.getBoundingClientRect().top)) -
          anchorTop,
      ),
    )
    .toBeLessThan(3);
});

test('a touch tap at the present does not disable following new messages', async ({ page }) => {
  const scroller = page.getByTestId('message-scroller');
  const distanceFromPresent = () =>
    scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  await expect.poll(distanceFromPresent).toBeLessThan(3);
  await scroller.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 120,
        clientY: 120,
        pointerType: 'touch',
      }),
    );
    element.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        clientX: 120,
        clientY: 120,
        pointerType: 'touch',
      }),
    );
  });
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 183,
        peerId: 'u:101',
        senderId: 'u:101',
        text: Array(12).fill('Message after a touch tap').join('\n'),
        date: 1_700_003_183,
        outgoing: false,
      },
    }),
  );
  await expect(page.locator('article[data-message-id="183"]')).toBeAttached();
  await expect.poll(distanceFromPresent).toBeLessThan(3);
});

test('editing a message updates its text inside the same article node', async ({ page }) => {
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Original live text',
        date: 1_700_003_000,
        outgoing: false,
      },
    }),
  );
  const article = page.locator('article[data-message-id="81"]');
  await expect(article).toContainText('Original live text');
  await mark(article, 'edited-article');

  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'edit-message',
      pts: 12,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: 'Edited live text',
        date: 1_700_003_000,
        outgoing: false,
        editedAt: 1_700_003_100,
      },
    }),
  );

  await expect(article).toContainText('Edited live text');
  await expectMarked(article, 'edited-article');
});

test('clicking the already-open chat performs no history or details requests', async ({ page }) => {
  const bubble = page.locator('article[data-message-id="79"]');
  await mark(bubble, 'bubble');
  const callsBefore = await fixtureStats(page);

  await chatButton(page, /Alice Fixture/).click();
  await page.waitForTimeout(50);

  await expectMarked(bubble, 'bubble');
  const callsAfter = await fixtureStats(page);
  expect(callsAfter?.getHistory).toBe(callsBefore?.getHistory);
  expect(callsAfter?.getSharedMediaCounts).toBe(callsBefore?.getSharedMediaCounts);
  expect(callsAfter?.readHistory).toBe(callsBefore?.readHistory);
});

test('switching away and back uses cached history and the same media URL', async ({ page }) => {
  const image = page.getByRole('img', { name: 'fixture.jpg', exact: true });
  const sourceBefore = await image.getAttribute('src');
  const callsBefore = await fixtureStats(page);

  await chatButton(page, /Release Channel/).click();
  await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready');
  await chatButton(page, /Alice Fixture/).click();
  await expect(image).toBeVisible();

  const callsAfter = await fixtureStats(page);
  expect(callsAfter?.getHistory).toBe(callsBefore?.getHistory);
  expect(callsAfter?.downloadMedia).toBe(callsBefore?.downloadMedia);
  await expect(image).toHaveAttribute('src', sourceBefore ?? '');
});

test('a switched conversation is revealed at its final scroll position without later movement', async ({
  page,
}) => {
  const scroller = page.getByTestId('message-scroller');
  await chatButton(page, /Release Channel/).click();
  await expect(scroller).toContainText('Release notes are ready');
  await expect(scroller.locator('.conversation-ready')).toBeVisible();

  const releasePosition = await scroller.evaluate((element) => ({
    top: element.scrollTop,
    height: element.scrollHeight,
  }));
  await page.waitForTimeout(250);
  expect(
    await scroller.evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
    })),
  ).toEqual(releasePosition);

  await chatButton(page, /Alice Fixture/).click();
  await expect(scroller.getByText('Newest message from fixture')).toBeVisible();
  await expect(scroller.locator('.conversation-ready')).toBeVisible();
  const alicePosition = await scroller.evaluate((element) => ({
    top: element.scrollTop,
    height: element.scrollHeight,
  }));
  await page.waitForTimeout(250);
  expect(
    await scroller.evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
    })),
  ).toEqual(alicePosition);
});

test('switching chats stays at the present after delayed media finishes layout', async ({
  page,
}) => {
  await page.goto('/?scenario=delayed-media');
  await chatButton(page, /Release Channel/).click();
  await expect(page.getByTestId('message-scroller')).toContainText('Release notes are ready');
  await chatButton(page, /Alice Fixture/).click();
  const scroller = page.getByTestId('message-scroller');
  await expect(scroller.getByText('Newest message from fixture')).toBeVisible();

  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(3);
  await expect(page.getByRole('img', { name: 'delayed-layout.tgs' })).toBeVisible();
  await page.waitForTimeout(100);
  expect(
    await scroller.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
    ),
  ).toBeLessThan(3);
});

test('unrelated state changes preserve the reading scroll position', async ({ page }) => {
  const scroller = page.getByTestId('message-scroller');
  const anchor = await scroller.evaluate(
    (element) =>
      new Promise<{ id: string; top: number }>((resolve, reject) => {
        element.addEventListener(
          'scroll',
          () => {
            const top = element.getBoundingClientRect().top;
            const message = [...element.querySelectorAll<HTMLElement>('article.message')].find(
              (candidate) => candidate.getBoundingClientRect().bottom >= top,
            );
            if (!message?.dataset.messageId) {
              reject(new Error('Visible message anchor is missing'));
              return;
            }
            resolve({ id: message.dataset.messageId, top: message.getBoundingClientRect().top });
          },
          { once: true },
        );
        element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
        element.scrollTop = 600;
      }),
  );

  await page.getByRole('textbox', { name: 'Message' }).fill('scroll-safe draft');
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.evaluate(() =>
    window.__televechaFixture?.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 13,
        peerId: 'g:303',
        senderId: 'u:404',
        text: 'Unrelated update',
        date: 1_700_003_000,
        outgoing: false,
      },
    }),
  );
  await expect(chatButton(page, /Fixture Group/)).toContainText('Unrelated update');

  const anchorAfter = page.locator(`article[data-message-id="${anchor.id}"]`);
  await expect
    .poll(async () =>
      Math.abs(
        (await anchorAfter.evaluate((element) => element.getBoundingClientRect().top)) - anchor.top,
      ),
    )
    .toBeLessThan(3);
});

test('deleting any number of leading anchors preserves the first surviving message before paint', async ({
  page,
}) => {
  const scroller = page.getByTestId('message-scroller');
  await scroller.hover();
  await page.mouse.wheel(0, -500);
  await waitForScrollToSettle(scroller);
  const anchors = await scroller.evaluate((element) => {
    const viewportTop = element.getBoundingClientRect().top;
    const visibleAndFollowing = [...element.querySelectorAll<HTMLElement>('article.message')]
      .filter((message) => message.getBoundingClientRect().bottom >= viewportTop)
      .slice(0, 5);
    const fallback = visibleAndFollowing[4];
    const removed = visibleAndFollowing.slice(0, 4);
    if (
      removed.length !== 4 ||
      removed.some((message) => !message.dataset.messageId) ||
      !fallback?.dataset.messageId
    ) {
      throw new Error('Five ordered anchors are required');
    }
    const fallbackTop = fallback.getBoundingClientRect().top;
    const offsets: number[] = [];
    let missing = 0;
    let sampling = true;
    const sample = () => {
      if (!sampling) return;
      const current = element.querySelector<HTMLElement>(
        `article[data-message-id="${CSS.escape(fallback.dataset.messageId!)}"]`,
      );
      if (current) offsets.push(current.getBoundingClientRect().top - fallbackTop);
      else missing += 1;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    Object.assign(window, {
      __deletedAnchorFrames: offsets,
      __deletedAnchorMissing: () => missing,
      __stopDeletedAnchorFrames: () => {
        sampling = false;
      },
    });
    return {
      removedIds: removed.map((message) => Number(message.dataset.messageId)),
      fallbackId: fallback.dataset.messageId,
      fallbackTop,
    };
  });

  await page.evaluate((messageIds) => {
    window.__televechaFixture?.emit({
      type: 'delete-messages',
      pts: 11,
      ptsCount: 1,
      peerId: 'u:101',
      messageIds,
    });
  }, anchors.removedIds);
  for (const messageId of anchors.removedIds) {
    await expect(page.locator(`article[data-message-id="${messageId}"]`)).toHaveCount(0);
  }
  const fallback = page.locator(`article[data-message-id="${anchors.fallbackId}"]`);
  await expect
    .poll(async () =>
      Math.abs(
        (await fallback.evaluate((element) => element.getBoundingClientRect().top)) -
          anchors.fallbackTop,
      ),
    )
    .toBeLessThan(3);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const frames = await page.evaluate(() => {
    const tracked = window as unknown as {
      __deletedAnchorFrames: number[];
      __deletedAnchorMissing: () => number;
      __stopDeletedAnchorFrames: () => void;
    };
    tracked.__stopDeletedAnchorFrames();
    return { offsets: tracked.__deletedAnchorFrames, missing: tracked.__deletedAnchorMissing() };
  });
  expect(frames.missing).toBe(0);
  expect(frames.offsets.length).toBeGreaterThan(0);
  expect(Math.max(...frames.offsets.map(Math.abs))).toBeLessThan(3);
});

test('fifty draft updates cause no message-list or chat-list child replacement', async ({
  page,
}) => {
  await page.evaluate(() => {
    const messages = document.querySelector('[data-testid="message-scroller"]');
    const chats = document.querySelector('[data-testid="chat-list"]');
    if (!messages || !chats) throw new Error('Missing fixture lists');
    const removals = { messages: 0, chats: 0 };
    new MutationObserver((records) => {
      removals.messages += records.reduce((count, record) => count + record.removedNodes.length, 0);
    }).observe(messages, { childList: true, subtree: true });
    new MutationObserver((records) => {
      removals.chats += records.reduce((count, record) => count + record.removedNodes.length, 0);
    }).observe(chats, { childList: true, subtree: true });
    const engine = window.__televechaRuntimes?.get('fixture:default')?.engine;
    if (!engine) throw new Error('Missing fixture engine');
    const setDraft = engine.setDraft.bind(engine);
    let draftWrites = 0;
    engine.setDraft = (...args) => {
      draftWrites += 1;
      return setDraft(...args);
    };
    Object.assign(window, { __uxRemovals: removals, __draftWrites: () => draftWrites });
  });
  const callsBefore = await fixtureStats(page);

  await page
    .getByRole('textbox', { name: 'Message' })
    .pressSequentially('1234567890'.repeat(5), { delay: 2 });
  await page.waitForTimeout(200);

  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __uxRemovals: { messages: number; chats: number } }).__uxRemovals,
    ),
  ).toEqual({ messages: 0, chats: 0 });
  expect(
    await page.evaluate(() =>
      (window as unknown as { __draftWrites: () => number }).__draftWrites(),
    ),
  ).toBeLessThanOrEqual(2);
  const callsAfter = await fixtureStats(page);
  expect(callsAfter?.getDialogs).toBe(callsBefore?.getDialogs);
  expect(callsAfter?.getHistory).toBe(callsBefore?.getHistory);
});

test('prepending older history preserves the visible node in the loaded DOM window', async ({
  page,
}) => {
  const scroller = page.getByTestId('message-scroller');
  const anchor = await scroller.evaluate(
    (element) =>
      new Promise<{ id: string; top: number }>((resolve, reject) => {
        element.addEventListener(
          'scroll',
          () => {
            const viewportTop = element.getBoundingClientRect().top;
            const message = [...element.querySelectorAll<HTMLElement>('article.message')].find(
              (candidate) => candidate.getBoundingClientRect().bottom >= viewportTop,
            );
            if (!message?.dataset.messageId) {
              reject(new Error('Visible message anchor is missing'));
              return;
            }
            resolve({ id: message.dataset.messageId, top: message.getBoundingClientRect().top });
          },
          { once: true },
        );
        element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
        element.scrollTop = 0;
      }),
  );
  const preserved = page.locator(`article[data-message-id="${anchor.id}"]`);
  await expect
    .poll(async () =>
      Math.abs(
        (await preserved.evaluate((element) => element.getBoundingClientRect().top)) - anchor.top,
      ),
    )
    .toBeLessThan(3);
  await expect.poll(() => scroller.locator('article.message').count()).toBeGreaterThan(50);
});
