import { createEffect, onCleanup, type Accessor } from 'solid-js';
import { activateFocusScope } from '../shared/focusScope';

/** Applies modal focus containment and restoration to responsive side drawers. */
export function createDrawerFocusSession(options: {
  root: Accessor<HTMLElement | undefined>;
  conversationPane: Accessor<HTMLElement | undefined>;
  mobileTrigger: Accessor<HTMLElement | undefined>;
  mobileOpen: Accessor<boolean>;
  detailsOpen: Accessor<boolean>;
  viewportWidth: Accessor<number>;
  closeMobile: () => void;
  closeDetails: () => void;
}) {
  createEffect(() => {
    const sidebarModal = options.mobileOpen() && options.viewportWidth() <= 650;
    const detailsModal = options.detailsOpen() && options.viewportWidth() <= 1100;
    if (!sidebarModal && !detailsModal) return;

    const root = options.root();
    const sidebar = root?.querySelector<HTMLElement>('[data-testid="chat-sidebar"]');
    const details = root?.querySelector<HTMLElement>('.details-pane');
    const panel = sidebarModal ? sidebar : details;
    if (!panel) return;
    const deactivate = activateFocusScope({
      root: panel,
      close: sidebarModal ? options.closeMobile : options.closeDetails,
      inert: [options.conversationPane(), detailsModal ? sidebar : undefined],
      initialFocus: () => panel,
      restoreFocus: () =>
        sidebarModal
          ? options.mobileTrigger()
          : document.querySelector<HTMLElement>('button[aria-label="Open details"]'),
    });
    onCleanup(deactivate);
  });
}
