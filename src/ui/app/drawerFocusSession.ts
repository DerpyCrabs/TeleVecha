import { activateFocusScope } from '../shared/focusScope';
import type { Read } from 'effectweb/session';

/** Applies modal focus containment and restoration to responsive side drawers. */
export function createDrawerFocusSession(options: {
  root: Read<HTMLElement | undefined>;
  conversationPane: Read<HTMLElement | undefined>;
  mobileTrigger: Read<HTMLElement | undefined>;
  mobileOpen: Read<boolean>;
  detailsOpen: Read<boolean>;
  viewportWidth: Read<number>;
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
    const panel = sidebarModal ? sidebar : details;
    const nextKind = sidebarModal ? 'sidebar' : 'details';
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
      close: sidebarModal ? options.closeMobile : options.closeDetails,
      inert: [options.conversationPane(), detailsModal ? sidebar : undefined],
      initialFocus: () => panel,
      restoreFocus: () =>
        sidebarModal
          ? options.mobileTrigger()
          : document.querySelector<HTMLElement>('button[aria-label="Open details"]'),
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
