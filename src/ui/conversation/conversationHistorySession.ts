import { createEffect, onCleanup, untrack, type Accessor } from 'solid-js';

import type { ChatMessage } from '../../domain/models';
import type { Conversation } from '../../telegram/core/conversation';
import type { EngineSnapshot, TelegramHistoryGap } from '../../telegram/types';
import type { ConversationViewport } from './conversationViewport';

interface ConversationHistoryOptions {
  snapshot: Accessor<EngineSnapshot>;
  activePeerId: Accessor<string>;
  conversation: Accessor<Conversation | undefined>;
  messages: Accessor<ChatMessage[]>;
  loaded: Accessor<boolean>;
  online: Accessor<boolean>;
  openingMessage: Accessor<boolean>;
  scroller: Accessor<HTMLDivElement | undefined>;
  viewport: Accessor<ConversationViewport>;
  maxRenderedMessages: number;
  cancelMessageOpen: () => void;
}

/** Owns history pagination, window shifts, gap loading, and scroll-anchor restoration. */
export function createConversationHistorySession(options: ConversationHistoryOptions) {
  let loadGeneration = 0;
  let restoreGeneration = 0;
  let loadRunning = false;
  let loadQueued = false;

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const reset = () => {
    loadGeneration += 1;
    restoreGeneration += 1;
    loadRunning = false;
    loadQueued = false;
  };

  const invalidateRestore = () => {
    restoreGeneration += 1;
  };

  const shiftWindow = (direction: -1 | 1) => {
    const scroller = options.scroller();
    if (!scroller) return;
    const viewport = options.viewport();
    viewport.invalidateAlignment();
    options.cancelMessageOpen();
    viewport.pauseAtHistory();
    const restoreAnchor = viewport.visibleAnchor(scroller);
    viewport.setAnchor(restoreAnchor);
    const peerId = options.activePeerId();
    const restore = ++restoreGeneration;
    const maxStart = Math.max(0, options.messages().length - options.maxRenderedMessages);
    viewport.setWindowStart(
      Math.max(
        0,
        Math.min(maxStart, viewport.windowStart() + direction * (options.maxRenderedMessages / 2)),
      ),
    );
    requestAnimationFrame(() => {
      if (
        restore !== restoreGeneration ||
        options.activePeerId() !== peerId ||
        options.scroller() !== scroller
      ) {
        return;
      }
      viewport.setAnchor(restoreAnchor);
      viewport.restoreAnchor(scroller, restoreAnchor);
      requestAnimationFrame(() => {
        if (
          restore !== restoreGeneration ||
          options.activePeerId() !== peerId ||
          options.scroller() !== scroller
        ) {
          return;
        }
        viewport.setAnchor(restoreAnchor);
        viewport.restoreAnchor(scroller, restoreAnchor);
        viewport.updateJump(scroller);
      });
    });
  };

  const loadOlder = async (scroller: HTMLDivElement, keepAtPresent = false) => {
    const viewport = options.viewport();
    if (scroller.scrollTop <= 120 && viewport.windowStart() > 0) {
      shiftWindow(-1);
      return;
    }
    const beforeLoad = options.snapshot();
    if (
      scroller.scrollTop > 120 ||
      !beforeLoad.hasOlderMessages ||
      beforeLoad.historyError ||
      beforeLoad.activePeerId !== options.activePeerId()
    ) {
      return;
    }
    if (!keepAtPresent) viewport.pauseAtHistory();
    if (loadRunning || beforeLoad.loadingOlderMessages) {
      loadQueued = true;
      return;
    }

    const generation = ++loadGeneration;
    const peerId = options.activePeerId();
    const restore = ++restoreGeneration;
    loadRunning = true;
    try {
      let pagesLoaded = 0;
      do {
        if (generation !== loadGeneration || options.activePeerId() !== peerId) break;
        loadQueued = false;
        const pageAnchor = keepAtPresent ? undefined : viewport.visibleAnchor(scroller);
        viewport.setAnchor(pageAnchor);
        const before = options.snapshot();
        const beforeCount = before.messages.length;
        const beforeOldestId = before.messages[0]?.id;
        const beforeHasOlder = before.hasOlderMessages;
        await options.conversation()?.loadOlder();
        pagesLoaded += 1;
        if (generation !== loadGeneration || options.activePeerId() !== peerId) break;
        const after = options.snapshot();
        const madeProgress =
          after.messages.length !== beforeCount ||
          after.messages[0]?.id !== beforeOldestId ||
          after.hasOlderMessages !== beforeHasOlder;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            if (
              generation === loadGeneration &&
              restore === restoreGeneration &&
              options.activePeerId() === peerId &&
              options.scroller() === scroller
            ) {
              if (keepAtPresent) viewport.alignToPresent(scroller);
              else {
                viewport.setAnchor(pageAnchor);
                viewport.restoreAnchor(scroller, pageAnchor);
              }
            }
            requestAnimationFrame(() => {
              if (
                generation === loadGeneration &&
                restore === restoreGeneration &&
                options.activePeerId() === peerId &&
                options.scroller() === scroller
              ) {
                if (keepAtPresent) viewport.alignToPresent(scroller);
                else {
                  viewport.setAnchor(pageAnchor);
                  viewport.restoreAnchor(scroller, pageAnchor);
                }
              }
              resolve();
            });
          });
        });
        if (!madeProgress || after.historyError || !options.online() || pagesLoaded >= 8) break;
      } while (
        generation === loadGeneration &&
        options.activePeerId() === peerId &&
        options.snapshot().hasOlderMessages &&
        (loadQueued || scroller.scrollHeight <= scroller.clientHeight + 120)
      );
    } finally {
      if (generation === loadGeneration) {
        loadRunning = false;
        loadQueued = false;
      }
    }
  };

  const loadGap = async (gap: TelegramHistoryGap) => {
    const scroller = options.scroller();
    const snapshot = options.snapshot();
    if (!scroller || loadRunning || snapshot.loadingOlderMessages) return;
    const viewport = options.viewport();
    viewport.pauseAtHistory();
    viewport.setReady(true);
    const generation = ++loadGeneration;
    const peerId = options.activePeerId();
    const restore = ++restoreGeneration;
    loadRunning = true;
    loadQueued = false;
    const restoreAnchor = viewport.visibleAnchor(scroller);
    viewport.setAnchor(restoreAnchor);
    try {
      await options.conversation()?.loadGap(gap);
      if (generation !== loadGeneration || options.activePeerId() !== peerId) return;
      await nextFrame();
      if (
        generation !== loadGeneration ||
        restore !== restoreGeneration ||
        options.activePeerId() !== peerId ||
        options.scroller() !== scroller
      ) {
        return;
      }
      viewport.setAnchor(restoreAnchor);
      viewport.restoreAnchor(scroller, restoreAnchor);
      await nextFrame();
      if (
        generation !== loadGeneration ||
        restore !== restoreGeneration ||
        options.activePeerId() !== peerId ||
        options.scroller() !== scroller
      ) {
        return;
      }
      viewport.setAnchor(restoreAnchor);
      viewport.restoreAnchor(scroller, restoreAnchor);
      viewport.updateJump(scroller);
    } finally {
      if (generation === loadGeneration) {
        loadRunning = false;
        loadQueued = false;
      }
    }
  };

  const gapBefore = (message: ChatMessage) => {
    const messageId = Number(message.id);
    if (!Number.isSafeInteger(messageId)) return undefined;
    return (options.snapshot().historyGaps ?? []).find(
      ({ newerMinMessageId }) => newerMinMessageId === messageId,
    );
  };

  createEffect(() => {
    const peerId = options.activePeerId();
    if (!peerId || !options.loaded()) return;
    const viewport = options.viewport();
    if (options.openingMessage()) {
      viewport.invalidateAlignment();
      viewport.setReady(true);
      return;
    }
    viewport.positionAtPresent(
      peerId,
      untrack(() => options.messages().length),
      options.loaded,
    );
  });

  createEffect(() => {
    const peerId = options.activePeerId();
    const loaded = options.loaded();
    const snapshot = options.snapshot();
    const messageCount = options.messages().length;
    const viewport = options.viewport();
    if (
      !loaded ||
      messageCount === 0 ||
      !snapshot.hasOlderMessages ||
      snapshot.loadingOlderMessages ||
      !viewport.followingPresent()
    ) {
      return;
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const scroller = options.scroller();
        const current = options.snapshot();
        if (
          !scroller ||
          options.activePeerId() !== peerId ||
          !options.loaded() ||
          !current.hasOlderMessages ||
          current.loadingOlderMessages ||
          !viewport.followingPresent() ||
          scroller.scrollHeight > scroller.clientHeight + 120
        ) {
          return;
        }
        void loadOlder(scroller, true);
      }),
    );
  });

  onCleanup(reset);

  return { reset, invalidateRestore, shiftWindow, loadOlder, loadGap, gapBefore };
}
