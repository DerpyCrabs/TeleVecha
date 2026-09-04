import { createEffect, onCleanup, untrack, type Accessor } from 'solid-js';

import type { ChatMessage } from '../../domain/models';
import type { EffectConversation } from '../../telegram/core/conversation';
import type { EngineSnapshot, TelegramHistoryGap } from '../../telegram/types';
import type { UiEffectRunner } from '../app/appRuntime';
import type { ConversationViewport } from './conversationViewport';

interface ConversationHistoryOptions {
  snapshot: Accessor<EngineSnapshot>;
  activePeerId: Accessor<string>;
  conversation: Accessor<EffectConversation | undefined>;
  runEffect: UiEffectRunner;
  loaded: Accessor<boolean>;
  openingMessage: Accessor<boolean>;
  unreadAfterId: Accessor<number | undefined>;
  scroller: Accessor<HTMLDivElement | undefined>;
  viewport: Accessor<ConversationViewport>;
}

/** Adapts viewport pagination requests to the active conversation. */
export function createConversationHistorySession(options: ConversationHistoryOptions) {
  let loadGeneration = 0;
  let loadRunning = false;

  const reset = () => {
    loadGeneration += 1;
    loadRunning = false;
  };

  const loadOlder = async (scroller: HTMLDivElement, keepAtPresent = false) => {
    const viewport = options.viewport();
    const beforeLoad = options.snapshot();
    if (
      scroller.scrollTop !== 0 ||
      !beforeLoad.hasOlderMessages ||
      beforeLoad.activePeerId !== options.activePeerId()
    ) {
      return;
    }
    if (!keepAtPresent) viewport.pauseAtHistory();
    if (loadRunning || beforeLoad.loadingOlderMessages) return;

    const generation = ++loadGeneration;
    loadRunning = true;
    try {
      const conversation = options.conversation();
      if (conversation) await options.runEffect(conversation.loadOlder());
    } finally {
      if (generation === loadGeneration) {
        loadRunning = false;
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
    loadRunning = true;
    try {
      const conversation = options.conversation();
      if (conversation) await options.runEffect(conversation.loadGap(gap));
      if (generation !== loadGeneration || options.activePeerId() !== peerId) return;
      viewport.updateJump(scroller);
    } finally {
      if (generation === loadGeneration) {
        loadRunning = false;
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
      viewport.setReady(true);
      return;
    }
    untrack(() => viewport.positionForPeer(peerId, options.unreadAfterId(), options.loaded));
  });

  createEffect(() => {
    const peerId = options.activePeerId();
    const snapshot = options.snapshot();
    const viewport = options.viewport();
    if (
      !options.loaded() ||
      !snapshot.hasOlderMessages ||
      snapshot.loadingOlderMessages ||
      !viewport.followingPresent()
    ) {
      return;
    }
    queueMicrotask(() => {
      const scroller = options.scroller();
      const current = options.snapshot();
      if (
        !scroller ||
        options.activePeerId() !== peerId ||
        !options.loaded() ||
        !current.hasOlderMessages ||
        current.loadingOlderMessages ||
        !viewport.followingPresent() ||
        scroller.scrollHeight > scroller.clientHeight
      ) {
        return;
      }
      void loadOlder(scroller, true).catch(() => undefined);
    });
  });

  onCleanup(reset);

  return { reset, loadOlder, loadGap, gapBefore };
}
