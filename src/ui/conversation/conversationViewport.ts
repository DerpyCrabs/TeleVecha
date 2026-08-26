import { onCleanup, type Accessor, type Setter } from 'solid-js';

const PRESENT_SCROLL_EPSILON = 0.5;

interface ConversationViewportOptions {
  scroller: Accessor<HTMLDivElement | undefined>;
  activePeerId: Accessor<string>;
  messageCount: Accessor<number>;
  windowIncludesPresent: Accessor<boolean>;
  windowStart: Accessor<number>;
  setWindowStart: Setter<number>;
  setJumpVisible: Setter<boolean>;
  setReady: Setter<boolean>;
  maxRenderedMessages: number;
  reportVisibility: () => void;
  loadOlder: (scroller: HTMLDivElement) => void;
  invalidateHistoryRestore: () => void;
  cancelMessageOpen: () => void;
}

interface HistoryAnchor {
  messageId: string;
  top: number;
}

export function createConversationViewport(options: ConversationViewportOptions) {
  let followingPresent = true;
  let positioningPresent = false;
  let positionGeneration = 0;
  let scrollWriteActive = false;
  let scrollWriteGeneration = 0;
  let scrollFrame: number | undefined;
  let anchor: HistoryAnchor | undefined;
  let touchStart: { x: number; y: number } | undefined;
  let pointerScrollActive = false;
  let userIntentActive = false;
  let userIntentTimer: ReturnType<typeof setTimeout> | undefined;
  let userIntentDirection: -1 | 0 | 1 = 0;
  let userIntentMoved = false;

  const visibleAnchor = (scroller: HTMLDivElement) => {
    const top = scroller.getBoundingClientRect().top;
    const message = [...scroller.querySelectorAll<HTMLElement>('article.message')].find(
      (candidate) => candidate.getBoundingClientRect().bottom >= top,
    );
    return message?.dataset.messageId
      ? { messageId: message.dataset.messageId, top: message.getBoundingClientRect().top }
      : undefined;
  };

  const restoreAnchor = (scroller: HTMLDivElement, target = anchor) => {
    if (!target) return;
    const message = scroller.querySelector<HTMLElement>(
      `article[data-message-id="${CSS.escape(target.messageId)}"]`,
    );
    if (message) scroller.scrollTop += message.getBoundingClientRect().top - target.top;
  };

  const invalidateAlignment = () => {
    positionGeneration += 1;
    positioningPresent = false;
    scrollWriteGeneration += 1;
    scrollWriteActive = false;
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
    scrollFrame = undefined;
  };

  const alignToPresent = (scroller: HTMLDivElement, settled?: () => void) => {
    const generation = ++scrollWriteGeneration;
    scrollWriteActive = true;
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
    const align = () => {
      if (generation !== scrollWriteGeneration) return;
      if (!followingPresent && !positioningPresent) {
        scrollWriteActive = false;
        scrollFrame = undefined;
        return;
      }
      scroller.scrollTop = scroller.scrollHeight;
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2) {
        scrollFrame = requestAnimationFrame(align);
        return;
      }
      scrollFrame = requestAnimationFrame(() => {
        if (generation !== scrollWriteGeneration) return;
        if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2) {
          scrollFrame = requestAnimationFrame(align);
          return;
        }
        scrollWriteActive = false;
        scrollFrame = undefined;
        if (followingPresent) {
          options.setJumpVisible(false);
          options.reportVisibility();
        }
        settled?.();
      });
    };
    align();
  };

  const updateJump = (scroller: HTMLDivElement, allowFollowingAtPresent = false) => {
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (
      allowFollowingAtPresent &&
      distance <= PRESENT_SCROLL_EPSILON &&
      options.windowIncludesPresent()
    ) {
      followingPresent = true;
      anchor = undefined;
    } else if (distance > PRESENT_SCROLL_EPSILON || !options.windowIncludesPresent()) {
      followingPresent = false;
      anchor = visibleAnchor(scroller);
    }
    options.setJumpVisible(!options.windowIncludesPresent() || distance > 160);
    options.reportVisibility();
  };

  const stopFollowing = (scroller: HTMLDivElement) => {
    invalidateAlignment();
    options.cancelMessageOpen();
    options.invalidateHistoryRestore();
    followingPresent = false;
    anchor = visibleAnchor(scroller);
    options.setReady(true);
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    options.setJumpVisible(!options.windowIncludesPresent() || distance > 160);
    options.reportVisibility();
  };

  const preserveReadingPosition = (scroller: HTMLDivElement) => {
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (!options.windowIncludesPresent() || distance > 8) stopFollowing(scroller);
  };

  const resetIntent = () => {
    userIntentDirection = 0;
    userIntentMoved = false;
  };
  const settleIntent = () => {
    if (pointerScrollActive || positioningPresent || scrollWriteActive) return false;
    const scroller = options.scroller();
    if (!scroller) return true;
    if (followingPresent) alignToPresent(scroller);
    else updateJump(scroller, userIntentDirection !== -1 || !userIntentMoved);
    return true;
  };
  const clearIntent = (settle = true) => {
    const hadIntent = userIntentActive || userIntentTimer !== undefined;
    if (userIntentTimer) clearTimeout(userIntentTimer);
    userIntentTimer = undefined;
    userIntentActive = false;
    if (!settle || !hadIntent || settleIntent()) resetIntent();
  };
  const markIntent = (direction: -1 | 0 | 1 = 0) => {
    if (userIntentTimer) clearTimeout(userIntentTimer);
    userIntentActive = true;
    if (direction) userIntentDirection = direction;
    userIntentTimer = setTimeout(() => {
      userIntentActive = false;
      userIntentTimer = undefined;
      if (settleIntent()) resetIntent();
    }, 180);
  };

  const preserveAnchor = () => {
    const scroller = options.scroller();
    if (scroller && !followingPresent) anchor = visibleAnchor(scroller);
  };

  const ensureAnchor = () => {
    if (anchor) return;
    const scroller = options.scroller();
    if (scroller && !followingPresent) anchor = visibleAnchor(scroller);
  };

  const pauseAtHistory = () => {
    invalidateAlignment();
    followingPresent = false;
  };

  const resetForPeer = () => {
    invalidateAlignment();
    options.invalidateHistoryRestore();
    followingPresent = true;
    anchor = undefined;
    options.setWindowStart(0);
    options.setJumpVisible(false);
    options.setReady(false);
  };

  const positionAtPresent = (peerId: string, messageCount: number, stillCurrent: () => boolean) => {
    invalidateAlignment();
    const generation = positionGeneration;
    positioningPresent = true;
    followingPresent = true;
    options.setWindowStart(Math.max(0, messageCount - options.maxRenderedMessages));
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (
          generation !== positionGeneration ||
          options.activePeerId() !== peerId ||
          !stillCurrent()
        )
          return;
        const scroller = options.scroller();
        if (!scroller) {
          positioningPresent = false;
          options.setReady(true);
          return;
        }
        alignToPresent(scroller, () => {
          if (
            generation !== positionGeneration ||
            options.activePeerId() !== peerId ||
            !stillCurrent()
          )
            return;
          positioningPresent = false;
          options.setJumpVisible(false);
          options.setReady(true);
          options.reportVisibility();
        });
      }),
    );
  };

  const jumpToPresent = () => {
    const scroller = options.scroller();
    if (!scroller) return;
    invalidateAlignment();
    const peerId = options.activePeerId();
    const generation = positionGeneration;
    followingPresent = true;
    anchor = undefined;
    options.setWindowStart(Math.max(0, options.messageCount() - options.maxRenderedMessages));
    requestAnimationFrame(() => {
      if (
        generation !== positionGeneration ||
        options.activePeerId() !== peerId ||
        options.scroller() !== scroller ||
        !followingPresent
      )
        return;
      alignToPresent(scroller, () => {
        if (generation !== positionGeneration || options.activePeerId() !== peerId) return;
        options.setJumpVisible(false);
        options.reportVisibility();
      });
    });
  };

  const handleKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    if (!['ArrowUp', 'PageUp', 'Home', 'ArrowDown', 'PageDown', 'End'].includes(event.key)) return;
    markIntent(['ArrowUp', 'PageUp', 'Home'].includes(event.key) ? -1 : 1);
    stopFollowing(event.currentTarget);
  };
  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    const scroller = event.currentTarget;
    if (positioningPresent || scrollWriteActive) return options.reportVisibility();
    if (followingPresent) return alignToPresent(scroller);
    if (!userIntentActive && !pointerScrollActive) {
      restoreAnchor(scroller);
      return options.reportVisibility();
    }
    userIntentMoved = true;
    markIntent();
    updateJump(scroller, userIntentDirection !== -1);
    options.loadOlder(scroller);
  };
  const handleWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    markIntent(event.deltaY < 0 ? -1 : event.deltaY > 0 ? 1 : 0);
    if (event.deltaY < 0) stopFollowing(event.currentTarget);
    else if (event.deltaY > 0) preserveReadingPosition(event.currentTarget);
    if (event.deltaY < 0 && event.currentTarget.scrollTop <= 120)
      options.loadOlder(event.currentTarget);
  };
  const handlePointerDown = (event: PointerEvent) => {
    const scroller = options.scroller();
    if (!scroller) return;
    if (event.pointerType === 'touch')
      return void (touchStart = { x: event.clientX, y: event.clientY });
    const bounds = scroller.getBoundingClientRect();
    const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth;
    if (
      (scrollbarWidth > 0 && event.clientX >= bounds.right - scrollbarWidth) ||
      event.button === 1
    ) {
      pointerScrollActive = true;
      markIntent();
      stopFollowing(scroller);
    } else {
      clearIntent();
      preserveReadingPosition(scroller);
    }
  };
  const handlePointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !touchStart) return;
    if (Math.abs(event.clientX - touchStart.x) < 4 && Math.abs(event.clientY - touchStart.y) < 4)
      return;
    const direction = event.clientY > touchStart.y ? -1 : 1;
    touchStart = undefined;
    pointerScrollActive = true;
    markIntent(direction);
    const scroller = options.scroller();
    if (scroller) stopFollowing(scroller);
  };
  const handlePointerEnd = () => {
    touchStart = undefined;
    if (pointerScrollActive) markIntent();
    pointerScrollActive = false;
  };

  onCleanup(() => {
    invalidateAlignment();
    clearIntent(false);
    options.invalidateHistoryRestore();
  });

  return {
    alignToPresent,
    captureAnchor: preserveAnchor,
    followingPresent: () => followingPresent,
    handleKeyDown,
    handlePointerDown,
    handlePointerEnd,
    handlePointerMove,
    handleScroll,
    handleWheel,
    ensureAnchor,
    invalidateAlignment,
    jumpToPresent,
    pauseAtHistory,
    positionAtPresent,
    preserveReadingPosition,
    resetForPeer,
    restoreAnchor,
    setAnchor: (next: HistoryAnchor | undefined) => void (anchor = next),
    stopFollowing,
    updateJump,
    visibleAnchor,
  };
}
