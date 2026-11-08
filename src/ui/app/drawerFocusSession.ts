import { activateFocusScope } from '../shared/focusScope';

/** Applies modal focus containment and restoration to responsive side drawers. */
export function createDrawerFocusSession(options: {
  root: () => HTMLElement | undefined;
  conversationPane: () => HTMLElement | undefined;
  mobileTrigger: () => HTMLElement | undefined;
  mobileOpen: () => boolean;
  detailsOpen: () => boolean;
  viewportWidth: () => number;
  closeMobile: () => void;
  closeDetails: () => void;
}) {
  let active: HTMLElement | undefined,
    kind = '';
  let release: (() => void) | undefined;
  const refresh = () => {
    const sidebarModal = options.mobileOpen() && options.viewportWidth() <= 650;
    const detailsModal = options.detailsOpen() && options.viewportWidth() <= 1100;
    if (!sidebarModal && !detailsModal) {
      release?.();
      release = undefined;
      active = undefined;
      kind = '';
      return;
    }
    const root = options.root();
    const sidebar = root?.querySelector<HTMLElement>('[data-testid="chat-sidebar"]');
    const details = root?.querySelector<HTMLElement>('.details-pane');
    // Details can open above the navigation drawer. Never make the active
    // focus scope inert, and release the old scope when the top panel changes.
    const panel = detailsModal ? details : sidebar;
    const nextKind = detailsModal ? 'details' : 'sidebar';
    if (panel === active && kind === nextKind) return;
    release?.();
    release = undefined;
    active = undefined;
    kind = '';
    if (!panel) return;
    active = panel;
    kind = nextKind;
    release = activateFocusScope({
      root: panel,
      close: detailsModal ? options.closeDetails : options.closeMobile,
      inert: [options.conversationPane(), detailsModal ? sidebar : undefined],
      initialFocus: () => panel,
      restoreFocus: () =>
        detailsModal
          ? document.querySelector<HTMLElement>('button[aria-label="Open details"]')
          : options.mobileTrigger(),
    });
  };
  return {
    refresh,
    dispose: () => {
      release?.();
      release = undefined;
      active = undefined;
    },
  };
}
