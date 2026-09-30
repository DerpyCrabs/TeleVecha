import { program, lifetime } from 'effectweb';
const WIDTH_STORAGE_KEY = 'televecha:left-sidebar-width';
const DETAILS_STORAGE_KEY = 'televecha:details-open';
const DEFAULT_WIDTH = 320;
export const SIDEBAR_MIN_WIDTH = 72;
export const SIDEBAR_MAX_WIDTH = 480;
const COMPACT_WIDTH = 128;
function clampWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}
function storedWidth() {
  try {
    const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}
function storedDetailsOpen() {
  try {
    return localStorage.getItem(DETAILS_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** Owns responsive drawer state, persisted width, and pointer/keyboard resizing. */
export function createSidebarLayout(options: { captureConversationAnchor: () => void }) {
  const scope = lifetime();
  type SidebarLayoutModel = {
    detailsOpen: boolean;
    viewportWidth: number;
    mobileOpen: boolean;
    width: number;
    resizing: boolean;
  };
  type SidebarLayoutMessage =
    | { type: 'DetailsOpen'; value: boolean }
    | { type: 'ViewportWidth'; value: number }
    | { type: 'MobileOpen'; value: boolean }
    | { type: 'Width'; value: number }
    | { type: 'Resizing'; value: boolean };
  const state = program<SidebarLayoutModel, SidebarLayoutMessage>({
    initial: {
      detailsOpen: window.innerWidth > 1100 && storedDetailsOpen(),
      viewportWidth: window.innerWidth,
      mobileOpen: false,
      width: storedWidth(),
      resizing: false,
    },
    update: (model, message) => {
      switch (message.type) {
        case 'DetailsOpen':
          return {
            model: Object.is(model.detailsOpen, message.value)
              ? model
              : { ...model, detailsOpen: message.value },
          };
        case 'ViewportWidth':
          return {
            model: Object.is(model.viewportWidth, message.value)
              ? model
              : { ...model, viewportWidth: message.value },
          };
        case 'MobileOpen':
          return {
            model: Object.is(model.mobileOpen, message.value)
              ? model
              : { ...model, mobileOpen: message.value },
          };
        case 'Width':
          return {
            model: Object.is(model.width, message.value)
              ? model
              : { ...model, width: message.value },
          };
        case 'Resizing':
          return {
            model: Object.is(model.resizing, message.value)
              ? model
              : { ...model, resizing: message.value },
          };
      }
    },
  });
  let stopResize: (() => void) | undefined;
  const responsiveMaxWidth = () =>
    state.model().viewportWidth <= 1100 && state.model().viewportWidth > 650
      ? Math.max(SIDEBAR_MIN_WIDTH, state.model().viewportWidth - 360)
      : SIDEBAR_MAX_WIDTH;
  const effectiveWidth = () => Math.min(state.model().width, responsiveMaxWidth());
  const compact = () => effectiveWidth() <= COMPACT_WIDTH;
  const updateDetailsOpen = (open: boolean) => {
    options.captureConversationAnchor();
    state.send({ type: 'DetailsOpen', value: open });
    if (open) state.send({ type: 'MobileOpen', value: false });
    try {
      localStorage.setItem(DETAILS_STORAGE_KEY, String(open));
    } catch {
      // The pane still changes when persistent storage is unavailable.
    }
  };
  const toggleMobile = () => {
    state.send({ type: 'MobileOpen', value: ((open) => !open)(state.model().mobileOpen) });
    state.send({ type: 'DetailsOpen', value: false });
  };
  const saveWidth = (nextWidth: number) => {
    const next = Math.min(clampWidth(nextWidth), responsiveMaxWidth());
    state.send({ type: 'Width', value: next });
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(next));
    } catch {
      // Resizing still works when persistent storage is unavailable.
    }
  };
  const startResize = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    options.captureConversationAnchor();
    const startWidth = effectiveWidth();
    let pendingWidth = startWidth;
    let frame: number | undefined;
    state.send({ type: 'Resizing', value: true });
    const renderWidth = () => {
      frame = undefined;
      state.send({ type: 'Width', value: pendingWidth });
    };
    const move = (moveEvent: PointerEvent) => {
      pendingWidth = Math.min(
        clampWidth(startWidth + moveEvent.clientX - startX),
        responsiveMaxWidth(),
      );
      if (frame === undefined) frame = requestAnimationFrame(renderWidth);
    };
    const finish = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      renderWidth();
      saveWidth(pendingWidth);
      state.send({ type: 'Resizing', value: false });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      stopResize = undefined;
    };
    stopResize = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  const resizeWithKeyboard = (event: KeyboardEvent) => {
    const current = effectiveWidth();
    const changes: Record<string, number> = {
      ArrowLeft: current - 16,
      ArrowRight: current + 16,
      Home: SIDEBAR_MIN_WIDTH,
      End: responsiveMaxWidth(),
    };
    const nextWidth = changes[event.key];
    if (nextWidth === undefined) return;
    event.preventDefault();
    options.captureConversationAnchor();
    saveWidth(nextWidth);
  };
  scope.own(() => stopResize?.());
  const actions = {
    setDetailsOpen: (value: boolean | ((previous: boolean) => boolean)) =>
      state.send({
        type: 'DetailsOpen',
        value: typeof value === 'function' ? value(state.model().detailsOpen) : value,
      }),
    setViewportWidth: (value: number | ((previous: number) => number)) =>
      state.send({
        type: 'ViewportWidth',
        value: typeof value === 'function' ? value(state.model().viewportWidth) : value,
      }),
    setMobileOpen: (value: boolean | ((previous: boolean) => boolean)) =>
      state.send({
        type: 'MobileOpen',
        value: typeof value === 'function' ? value(state.model().mobileOpen) : value,
      }),
    updateDetailsOpen,
    toggleMobile,
    startResize,
    resizeWithKeyboard,
  };
  return {
    ...actions,
    model: state.model,
    subscribe: state.subscribe,
    dispose: () => {
      scope.dispose();
      state.dispose();
    },
    snapshot: () => ({
      ...actions,
      detailsOpen: state.model().detailsOpen,
      viewportWidth: state.model().viewportWidth,
      mobileOpen: state.model().mobileOpen,
      resizing: state.model().resizing,
      responsiveMaxWidth: responsiveMaxWidth(),
      effectiveWidth: effectiveWidth(),
      compact: compact(),
    }),
  };
}
export type SidebarLayout = ReturnType<ReturnType<typeof createSidebarLayout>['snapshot']>;
