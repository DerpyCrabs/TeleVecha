import { program } from 'effectweb';
import { Effect } from 'effect';
import type {
  ConversationViewportEffect,
  ConversationViewportEvent,
  ConversationViewportState,
} from './conversationViewportMachine';
import {
  initialConversationViewportState,
  transitionConversationViewport,
} from './conversationViewportMachine';
const commandDom = 'dom';

interface ConversationMessage {
  id: string;
  outgoing: boolean;
}
interface ConversationViewportOptions {
  scroller: () => HTMLDivElement | undefined;
  activePeerId: () => string;
  messages: () => readonly ConversationMessage[];
  canLoadOlder: () => boolean;
  reportVisibility: () => void;
  dismissUnreadMarker: () => void;
  loadOlder: (scroller: HTMLDivElement) => Promise<void>;
  cancelMessageOpen: () => void;
}
interface ReadingAnchorPoint {
  element: HTMLElement;
  top: number;
  bottom: number;
}

/**
 * Full-DOM conversation scrolling.
 *
 * At the present edge, layout changes remain bottom-pinned. While reading,
 * the first surviving visible row remains at the same viewport coordinate.
 * ResizeObserver and MutationObserver apply both invariants before paint.
 * User input selects reading mode; scroll events only observe boundaries.
 */
export function createConversationViewport(options: ConversationViewportOptions) {
  type Input = {
    type: 'Viewport';
    event: ConversationViewportEvent;
    scroller: HTMLDivElement | undefined;
  };
  const source = program<ConversationViewportState, Input>({
    initial: initialConversationViewportState,
    update: (state, input) => {
      const next = transitionConversationViewport(state, input.event);
      const model =
        next.state.mode === state.mode &&
        next.state.phase === state.phase &&
        next.state.pagination === state.pagination
          ? state
          : next.state;
      return {
        model,
        commands: [
          {
            key: commandDom,
            policy: 'replace',
            effect: Effect.sync(() => {
              applyEffects(next.effects, input.scroller);
              options.reportVisibility();
            }),
          },
        ],
      };
    },
  });
  const followingPresent = () => source.model().mode === 'present';
  const jumpVisible = () => source.model().mode === 'history';
  const ready = () => source.model().phase === 'ready';
  let positionedPeer = '';
  let prependHeight: number | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let mutationObserver: MutationObserver | undefined;
  let observedRows = new Set<HTMLElement>();
  let readingAnchors: ReadingAnchorPoint[] = [];
  let geometry: ReadingAnchorPoint[] = [];
  let geometryDirty = true;
  let geometryOrdered = true;
  let anchorIndex = 0;
  let anchorScrollTop = 0;
  let anchorViewportTop = 0;
  let touchY: number | undefined;
  let lastPresentScrollTop = 0;
  const atPresent = (scroller: HTMLDivElement) => {
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distance <= 2) return true;
    const marker = scroller.querySelector<HTMLElement>('.present-scroll-anchor');
    if (!marker) return options.messages().length === 0;
    const markerBounds = marker.getBoundingClientRect();
    const viewportBounds = scroller.getBoundingClientRect();
    return (
      markerBounds.top >= viewportBounds.top - 2 && markerBounds.bottom <= viewportBounds.bottom + 2
    );
  };
  const captureReadingAnchors = (scroller: HTMLDivElement) => {
    const viewportTop = scroller.getBoundingClientRect().top;
    const scrollTop = scroller.scrollTop;
    if (geometryDirty) {
      // Keep all fallback positions for arbitrarily large deletions, but measure only
      // after layout changes. Scrolling changes viewport coordinates, not these offsets.
      const rows = new Set(scroller.querySelectorAll<HTMLElement>('article.message'));
      geometry = [...rows].flatMap((element) => {
        const bounds = element.getBoundingClientRect();
        if (bounds.width === 0 && bounds.height === 0) return [];
        return [
          {
            element,
            top: bounds.top - viewportTop + scrollTop,
            bottom: bounds.bottom - viewportTop + scrollTop,
          },
        ];
      });
      for (const element of observedRows)
        if (!rows.has(element)) resizeObserver?.unobserve(element);
      for (const element of rows) if (!observedRows.has(element)) resizeObserver?.observe(element);
      observedRows = rows;
      geometryOrdered = geometry.every(
        (point, index) => index === 0 || point.bottom >= geometry[index - 1]!.bottom,
      );
      geometryDirty = false;
    }
    readingAnchors = geometry;
    anchorIndex = firstReadingAnchor(readingAnchors, scrollTop, geometryOrdered);
    anchorScrollTop = scrollTop;
    anchorViewportTop = viewportTop;
  };
  const preserveReadingAnchor = (scroller: HTMLDivElement) => {
    // DOM order remains the fallback priority even for hidden or overlapping rows.
    let anchor: ReadingAnchorPoint | undefined;
    for (let index = anchorIndex; index < readingAnchors.length; index++) {
      const candidate = readingAnchors[index]!;
      if (candidate.bottom >= anchorScrollTop && candidate.element.isConnected) {
        anchor = candidate;
        break;
      }
    }
    if (!anchor)
      for (let index = readingAnchors.length - 1; index >= 0; index--) {
        const candidate = readingAnchors[index]!;
        if (candidate.bottom < anchorScrollTop && candidate.element.isConnected) {
          anchor = candidate;
          break;
        }
      }
    if (!anchor) return;
    const delta =
      anchor.element.getBoundingClientRect().top -
      (anchor.top - anchorScrollTop + anchorViewportTop);
    if (delta !== 0) scroller.scrollTop += delta;
  };
  const pinPresent = (scroller: HTMLDivElement) => {
    scroller.scrollTop = scroller.scrollHeight;
    lastPresentScrollTop = scroller.scrollTop;
  };
  const applyEffects = (
    effects: ConversationViewportEffect[],
    scroller: HTMLDivElement | undefined,
  ) => {
    for (const effect of effects) {
      if (effect === 'pin-present' && scroller) pinPresent(scroller);
      if (effect === 'capture-reading-anchor' && scroller) captureReadingAnchors(scroller);
      if (effect === 'preserve-reading-anchor' && scroller) preserveReadingAnchor(scroller);
      if (effect === 'request-older') {
        if (!scroller) {
          dispatch({ type: 'older-load-settled' });
          continue;
        }
        prependHeight = scroller.scrollHeight;
        void options
          .loadOlder(scroller)
          .catch(() => undefined)
          .finally(() => dispatch({ type: 'older-load-settled' }, scroller));
      }
    }
  };
  function dispatch(
    event: ConversationViewportEvent,
    scroller: HTMLDivElement | undefined = options.scroller(),
  ) {
    if (event.type === 'geometry-changed' || event.type === 'content-changed') {
      geometryDirty = true;
      // ResizeObserver may run before the scroll event. Respect a position
      // already moved away from the tail instead of undoing that movement.
      if (
        scroller &&
        followingPresent() &&
        scroller.scrollTop < lastPresentScrollTop - 2 &&
        !atPresent(scroller)
      ) {
        source.send({ type: 'Viewport', event: { type: 'user-left-present' }, scroller });
        captureReadingAnchors(scroller);
      }
    }
    source.send({ type: 'Viewport', event, scroller });
  }
  let wasEmpty = false;
  const refresh = () => {
    const empty = options.messages().length === 0;
    if (empty && !wasEmpty) dispatch({ type: 'conversation-empty' });
    wasEmpty = empty;
  };
  const readHistory = (scroller: HTMLDivElement) => {
    if (!followingPresent()) return;
    options.cancelMessageOpen();
    dispatch({ type: 'user-left-present' }, scroller);
  };
  const attach = (scroller: HTMLDivElement, content: HTMLDivElement) => {
    const handleScroll = () => {
      if (followingPresent() && !atPresent(scroller)) {
        // Observe the actual position, including keyboard, scrollbar and
        // accessibility scrolling. Never pull a scroll event back to the tail.
        dispatch({ type: 'user-left-present' }, scroller);
      }
      if (!followingPresent() && atPresent(scroller)) {
        options.dismissUnreadMarker();
        dispatch({ type: 'present-visible' }, scroller);
      }
      dispatch({ type: 'viewport-scrolled' }, scroller);
      if (!followingPresent() && ready() && scroller.scrollTop === 0) {
        dispatch({ type: 'top-reached', canLoad: options.canLoadOlder() }, scroller);
      }
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) readHistory(scroller);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
        (event.key === ' ' && event.shiftKey)
      ) {
        readHistory(scroller);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        touchY = event.clientY;
        return;
      }
      if (event.button === 1) readHistory(scroller);
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || touchY === undefined || event.clientY === touchY) return;
      touchY = event.clientY;
      readHistory(scroller);
    };
    const handlePointerEnd = () => {
      touchY = undefined;
    };
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    scroller.addEventListener('wheel', handleWheel, { passive: true });
    scroller.addEventListener('keydown', handleKeyDown);
    scroller.addEventListener('pointerdown', handlePointerDown);
    scroller.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd, true);
    window.addEventListener('pointercancel', handlePointerEnd, true);
    resizeObserver = new ResizeObserver(() => {
      dispatch({ type: 'geometry-changed' }, scroller);
    });
    resizeObserver.observe(scroller);
    resizeObserver.observe(content);
    mutationObserver = new MutationObserver((records) => {
      if (
        !followingPresent() &&
        prependHeight !== undefined &&
        records.some((record) => record.type === 'childList' && record.target === content)
      ) {
        const addedHeight = scroller.scrollHeight - prependHeight;
        if (addedHeight !== 0) {
          scroller.scrollTop += addedHeight;
          prependHeight = undefined;
        }
      }
      dispatch({ type: 'content-changed' }, scroller);
    });
    mutationObserver.observe(content, { childList: true });
    return () => {
      scroller.removeEventListener('scroll', handleScroll);
      scroller.removeEventListener('wheel', handleWheel);
      scroller.removeEventListener('keydown', handleKeyDown);
      scroller.removeEventListener('pointerdown', handlePointerDown);
      scroller.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd, true);
      window.removeEventListener('pointercancel', handlePointerEnd, true);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      observedRows.clear();
      geometryDirty = true;
      resizeObserver = undefined;
      mutationObserver = undefined;
    };
  };
  const resetForPeer = () => {
    positionedPeer = '';
    prependHeight = undefined;
    readingAnchors = [];
    geometry = [];
    for (const element of observedRows) resizeObserver?.unobserve(element);
    observedRows.clear();
    geometryDirty = true;
    dispatch({ type: 'peer-reset' });
  };
  const positionForPeer = (
    peerId: string,
    unreadAfterId: number | undefined,
    stillCurrent: () => boolean,
  ) => {
    if (!stillCurrent() || positionedPeer === peerId) return;
    positionedPeer = peerId;
    queueMicrotask(() => {
      if (options.activePeerId() !== peerId || !stillCurrent()) return;
      const scroller = options.scroller();
      const unread =
        unreadAfterId === undefined
          ? undefined
          : options
              .messages()
              .find((message) => !message.outgoing && Number(message.id) > unreadAfterId);
      const selector = unread ? `[data-unread-message-id="${CSS.escape(unread.id)}"]` : undefined;
      const target = selector ? scroller?.querySelector<HTMLElement>(selector) : undefined;
      if (!scroller || !target) {
        dispatch({ type: 'peer-positioned' }, scroller);
        return;
      }
      const alignUnread = () => {
        const currentTarget = scroller.querySelector<HTMLElement>(selector!);
        if (!currentTarget) return;
        scroller.scrollTop +=
          currentTarget.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      };
      const unreadTailFits = () => {
        const currentTarget = scroller.querySelector<HTMLElement>(selector!);
        const present = scroller.querySelector<HTMLElement>('.present-scroll-anchor');
        if (!currentTarget || !present) return false;
        return (
          present.getBoundingClientRect().bottom - currentTarget.getBoundingClientRect().top <=
          scroller.clientHeight + 2
        );
      };
      if (unreadTailFits()) {
        dispatch({ type: 'peer-positioned' }, scroller);
        return;
      }
      alignUnread();
      dispatch({ type: 'history-target-opened' }, scroller);
      requestAnimationFrame(() => {
        if (options.activePeerId() !== peerId || !stillCurrent()) return;
        dispatch({ type: 'viewport-ready' }, scroller);
        requestAnimationFrame(() => {
          if (options.activePeerId() !== peerId || !stillCurrent()) return;
          readingAnchors = [];
          geometry = [];
          geometryDirty = true;
          if (unreadTailFits()) {
            dispatch({ type: 'peer-positioned' }, scroller);
            return;
          }
          alignUnread();
          dispatch({ type: 'reading-anchor-requested' }, scroller);
        });
      });
    });
  };
  const positionAtPresent = (peerId: string, stillCurrent: () => boolean) =>
    positionForPeer(peerId, undefined, stillCurrent);
  const jumpToPresent = () => {
    options.cancelMessageOpen();
    options.dismissUnreadMarker();
    const scroller = options.scroller();
    dispatch({ type: 'jump-to-present' }, scroller);
  };
  const showMessage = (messageIndex: number) => {
    const scroller = options.scroller();
    const message = options.messages()[messageIndex];
    if (!scroller || !message) return false;
    const target = scroller.querySelector<HTMLElement>(
      `article[data-message-id="${CSS.escape(message.id)}"]`,
    );
    if (!target) return false;
    // A fetched target can change height before ResizeObserver has refreshed
    // the row geometry. Anchor the new position against the current layout.
    geometryDirty = true;
    dispatch({ type: 'history-target-opened' }, scroller);
    target.scrollIntoView({ block: 'center' });
    captureReadingAnchors(scroller);
    dispatch({ type: 'viewport-scrolled' }, scroller);
    return true;
  };
  const reveal = (target: HTMLElement) => {
    const scroller = options.scroller();
    if (!scroller?.contains(target)) return false;
    // A fetched target can change height before ResizeObserver has refreshed
    // the row geometry. Anchor the new position against the current layout.
    geometryDirty = true;
    dispatch({ type: 'history-target-opened' }, scroller);
    target.scrollIntoView({ block: 'center' });
    captureReadingAnchors(scroller);
    dispatch({ type: 'viewport-scrolled' }, scroller);
    return true;
  };
  return {
    refresh,
    subscribe: source.subscribe,
    dispose: () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      source.dispose();
    },
    snapshot: () => ({
      jumpVisible: jumpVisible(),
      ready: ready(),
      followingPresent: followingPresent(),
    }),
    attach,
    jumpVisible,
    ready,
    setReady: (next: boolean) => dispatch({ type: next ? 'viewport-ready' : 'viewport-hidden' }),
    followingPresent,
    jumpToPresent,
    positionForPeer,
    positionAtPresent,
    resetForPeer,
    reveal,
    showMessage,
    pauseAtHistory: () => {
      dispatch({ type: 'history-target-opened' });
    },
    reconcileLayout: () => {
      // Native textarea edits may briefly shrink field-sizing content and clamp
      // scrollTop before the input handler runs. This is an explicit composer
      // layout change, not a user scroll; retain the existing reading mode.
      geometryDirty = true;
      source.send({
        type: 'Viewport',
        event: { type: 'geometry-changed' },
        scroller: options.scroller(),
      });
    },
    preserveReadingPosition: (scroller: HTMLDivElement) => {
      dispatch({ type: 'reading-anchor-requested' }, scroller);
    },
    captureAnchor: () => {
      dispatch({ type: 'reading-anchor-requested' });
    },
    updateJump: (scroller: HTMLDivElement, allowFollowing: boolean = false) => {
      if (allowFollowing && atPresent(scroller)) dispatch({ type: 'present-visible' }, scroller);
      options.reportVisibility();
    },
  };
}
export type ConversationViewport = ReturnType<typeof createConversationViewport>;

export function firstReadingAnchor(
  points: readonly { bottom: number }[],
  top: number,
  ordered: boolean,
) {
  if (!ordered) {
    const index = points.findIndex((point) => point.bottom >= top);
    return index < 0 ? points.length : index;
  }
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle]!.bottom < top) low = middle + 1;
    else high = middle;
  }
  return low;
}
