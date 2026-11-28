import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady, selectAlice } from './helpers';

test('runs a widget in the official sandbox without isolating the main messenger', async ({
  page,
}) => {
  const errors: string[] = [];
  page.context().on('page', (opened) => {
    opened.on('pageerror', (error) => errors.push(error.message));
    opened.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
  });
  await openReady(page);
  await selectAlice(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  await page.evaluate(() =>
    window.__televechaFixture!.emit({
      type: 'new-message',
      pts: 11,
      ptsCount: 1,
      message: {
        id: 81,
        peerId: 'u:101',
        senderId: 'u:101',
        text: '',
        date: 1_700_002_000,
        outgoing: false,
        widget: {
          width: 320,
          height: 160,
          isCopy: false,
          canQuery: true,
          backgroundQuery: false,
          html: '<html><body><div id="value">Count: 0</div><button id="add">Add</button><button id="query">Ask bot</button><div id="answer"></div><div id="state"></div><script>TelegramWidget.onEvent("publicDataChanged",()=>{document.getElementById("state").textContent=TelegramWidget.publicData});let n=0;document.getElementById("add").addEventListener("click",()=>{document.getElementById("value").textContent="Count: "+(++n)});document.getElementById("query").addEventListener("click",()=>{TelegramWidget.request("ping").then(r=>{document.getElementById("answer").textContent=r.result})});</script></body></html>',
        },
      },
    }),
  );
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open interactive widget' }).click();
  const popup = await opened;
  await expect.poll(() => popup.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(popup.getByText('Count: 0', { exact: true })).toBeVisible();
  await popup.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(popup.getByText('Count: 1', { exact: true })).toBeVisible();
  await popup.getByRole('button', { name: 'Ask bot', exact: true }).click();
  await expect(popup.getByText('Pong: ping', { exact: true })).toBeVisible();
  await page.evaluate(() =>
    window.__televechaFixture!.emit({
      type: 'widget-data',
      peerId: 'u:101',
      messageId: 81,
      publicData: 'Updated by the bot',
      pts: 12,
      ptsCount: 1,
    }),
  );
  await expect(popup.getByText('Updated by the bot', { exact: true })).toBeVisible();
  await expect(popup.getByText('Count: 1', { exact: true })).toBeVisible();
  await popup.screenshot({
    path: test.info().outputPath('televecha-widget.png'),
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
  await popup.close();
});
