import { runScenario } from '@derpdesign/harness';
import { installFixtureLocks } from './browser-mocks';

const initialUrl = location.href;
let mounted = false;

function element(selector: string): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const match = document.querySelector<HTMLElement>(selector);
      if (!match) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(match);
    };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(Error('Gallery did not render ' + selector));
    }, 30000);
    observer.observe(document.body, { childList: true, attributes: true, subtree: true });
    check();
  });
}
async function settleLayout() {
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  const surfaces = document.querySelectorAll(
    '.conversation-ready,.menu-surface,.expression-picker,.settings-dialog,.details-pane',
  );
  await Promise.allSettled(
    [...surfaces].flatMap((surface) =>
      (surface.getAnimations?.() ?? [])
        .filter((animation) =>
          Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)),
        )
        .map((animation) => animation.finished),
    ),
  );
}
installFixtureLocks();
await runScenario(async ({ conditions }) => {
  if (mounted) {
    location.replace(initialUrl);
    return;
  }
  mounted = true;
  await element('.conversation-ready article[data-message-id]');
  await settleLayout();
  if (typeof conditions.message === 'number') {
    const message = await element(
      `.conversation-ready article[data-message-id="${conditions.message}"]`,
    );
    message.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
  switch (conditions.panel) {
    case 'expressions':
      (await element('[aria-label="Choose emoji, GIF, or sticker"]')).click();
      await element('.expression-picker');
      break;
    case 'attach':
      (await element('[aria-label="Attach files"]')).click();
      await element('.composer-attach-menu');
      break;
    case 'chat': {
      const row = await element('.chat-row.active');
      const box = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: box.left + 32,
          clientY: box.bottom - 6,
        }),
      );
      await element('.chat-context-menu');
      break;
    }
    case 'settings':
    case 'main':
      (await element('[aria-label="Open main menu"]')).click();
      await element('.sidebar-main-menu:popover-open');
      if (conditions.panel === 'settings') {
        (await element('[aria-label="Open settings"]')).click();
        await element('.settings-dialog');
      }
      break;
  }
  await settleLayout();
});
