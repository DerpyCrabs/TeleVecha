import { test } from '@playwright/test';
import { expect } from './expect';

test('row resize preserves reading position even when total history height is unchanged', async ({
  page,
}) => {
  await page.goto('/e2e/fixtures/index.html');
  const result = await page.evaluate(async () => {
    const path = '/src/ui/conversation/conversationViewport.ts';
    const { createConversationViewport } = (await import(
      path
    )) as typeof import('../src/ui/conversation/conversationViewport');
    const scroller = document.createElement('div');
    scroller.style.cssText =
      'height:200px;overflow:auto;overflow-anchor:none;position:fixed;inset:0;width:300px';
    const content = document.createElement('div');
    const rows = Array.from({ length: 100 }, (_, id) => {
      const row = document.createElement('article');
      row.className = 'message';
      row.style.cssText = 'height:40px;box-sizing:border-box;margin:0;padding:0;border:0';
      row.textContent = String(id);
      content.append(row);
      return row;
    });
    scroller.append(content);
    document.body.append(scroller);
    const viewport = createConversationViewport({
      scroller: () => scroller,
      activePeerId: () => 'chat',
      messages: () => rows.map((_, id) => ({ id: String(id), outgoing: false })),
      canLoadOlder: () => false,
      reportVisibility: () => {},
      dismissUnreadMarker: () => {},
      loadOlder: async () => {},
      cancelMessageOpen: () => {},
    });
    const detach = viewport.attach(scroller, content);
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      viewport.jumpToPresent();
      await frame();
      await frame();
      scroller.scrollTop = 1000;

      await frame();
      await frame();
      viewport.captureAnchor();
      const scrolledTop = scroller.scrollTop;
      const followingPresent = viewport.snapshot().followingPresent;
      const before = rows[25]!.getBoundingClientRect().top;
      const height = scroller.scrollHeight;
      rows[20]!.style.height = '80px';
      rows[35]!.style.height = '0px';
      await frame();
      await frame();
      const after = rows[25]!.getBoundingClientRect().top;
      return {
        before,
        after,
        height,
        scrolledTop,
        followingPresent,
        nextHeight: scroller.scrollHeight,
      };
    } finally {
      detach();
      viewport.dispose();
      scroller.remove();
    }
  });
  expect(result.scrolledTop).toBe(1000);
  expect(result.followingPresent).toBe(false);
  expect(result.nextHeight).toBe(result.height);
  expect(Math.abs(result.after - result.before)).toBeLessThan(1);
});
