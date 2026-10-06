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
  let readingAnchors: ReadingAnchorPoint[] = [];
  let touchY: number | undefined;
  let pointerScrollCandidate = false;
  const isScrollbarPointer = (scroller: HTMLDivElement, event: PointerEvent) => {
    if (event.target !== scroller || event.pointerType === 'touch') return false;
    const bounds = scroller.getBoundingClientRect();
    const scrollbarStart = Math.min(bounds.left + scroller.clientWidth, bounds.right - 12);
    return event.clientX >= scrollbarStart;
  };
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
    const measured = [...scroller.querySelectorAll<HTMLElement>('article.message')].map(
      (element) => ({ element, bounds: element.getBoundingClientRect() }),
    );
    const atOrAfterViewport = measured.filter(({ bounds }) => bounds.bottom >= viewportTop);
    const beforeViewport = measured.filter(({ bounds }) => bounds.bottom < viewportTop).reverse();
    readingAnchors = [...atOrAfterViewport, ...beforeViewport].map(({ element, bounds }) => ({
      element,
      top: bounds.top,
    }));
  };
  const preserveReadingAnchor = (scroller: HTMLDivElement) => {
    const anchor = readingAnchors.find(({ element }) => element.isConnected);
    if (!anchor) return;
    const delta = anchor.element.getBoundingClientRect().top - anchor.top;
    if (delta !== 0) scroller.scrollTop += delta;
  };
  const pinPresent = (scroller: HTMLDivElement) => {
    scroller.scrollTop = scroller.scrollHeight;
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
      if (followingPresent() && pointerScrollCandidate && !atPresent(scroller)) {
        readHistory(scroller);
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
      pointerScrollCandidate = event.button === 0 && isScrollbarPointer(scroller, event);
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
      pointerScrollCandidate = false;
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
    mutationObserver = new MutationObserver(() => {
      if (!followingPresent() && prependHeight !== undefined) {
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
      resizeObserver = undefined;
      mutationObserver = undefined;
    };
  };
  const resetForPeer = () => {
    positionedPeer = '';
    prependHeight = undefined;
    readingAnchors = [];
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
    dispatch({ type: 'history-target-opened' }, scroller);
    target.scrollIntoView({ block: 'center' });
    dispatch({ type: 'viewport-scrolled' }, scroller);
    return true;
  };
  const reveal = (target: HTMLElement) => {
    const scroller = options.scroller();
    if (!scroller?.contains(target)) return false;
    dispatch({ type: 'history-target-opened' }, scroller);
    target.scrollIntoView({ block: 'center' });
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
      dispatch({ type: 'geometry-changed' });
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
