import { createSignal, onCleanup } from 'solid-js';

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
  const [detailsOpen, setDetailsOpen] = createSignal(
    window.innerWidth > 1100 && storedDetailsOpen(),
  );
  const [viewportWidth, setViewportWidth] = createSignal(window.innerWidth);
  const [mobileOpen, setMobileOpen] = createSignal(false);
  const [width, setWidth] = createSignal(storedWidth());
  const [resizing, setResizing] = createSignal(false);
  let stopResize: (() => void) | undefined;

  const responsiveMaxWidth = () =>
    viewportWidth() <= 1100 && viewportWidth() > 650
      ? Math.max(SIDEBAR_MIN_WIDTH, viewportWidth() - 360)
      : SIDEBAR_MAX_WIDTH;
  const effectiveWidth = () => Math.min(width(), responsiveMaxWidth());
  const compact = () => effectiveWidth() <= COMPACT_WIDTH;

  const updateDetailsOpen = (open: boolean) => {
    options.captureConversationAnchor();
    setDetailsOpen(open);
    if (open) setMobileOpen(false);
    try {
      localStorage.setItem(DETAILS_STORAGE_KEY, String(open));
    } catch {
      // The pane still changes when persistent storage is unavailable.
    }
  };

  const toggleMobile = () => {
    setMobileOpen((open) => !open);
    setDetailsOpen(false);
  };

  const saveWidth = (nextWidth: number) => {
    const next = Math.min(clampWidth(nextWidth), responsiveMaxWidth());
    setWidth(next);
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
    setResizing(true);

    const renderWidth = () => {
      frame = undefined;
      setWidth(pendingWidth);
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
      setResizing(false);
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

  onCleanup(() => stopResize?.());

  return {
    detailsOpen,
    setDetailsOpen,
    viewportWidth,
    setViewportWidth,
    mobileOpen,
    setMobileOpen,
    resizing,
    responsiveMaxWidth,
    effectiveWidth,
    compact,
    updateDetailsOpen,
    toggleMobile,
    startResize,
    resizeWithKeyboard,
  };
}

export type SidebarLayout = ReturnType<typeof createSidebarLayout>;
