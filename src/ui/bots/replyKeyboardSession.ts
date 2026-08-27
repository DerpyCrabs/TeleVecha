import { createEffect, createMemo, createSignal, type Accessor } from 'solid-js';

import type { EngineSnapshot } from '../../telegram/types';

/** Owns reply-keyboard visibility, single-use dismissal, and forced replies. */
export function createReplyKeyboardSession(options: {
  snapshot: Accessor<EngineSnapshot>;
  activePeerId: Accessor<string>;
  reply: Accessor<unknown>;
  editing: Accessor<unknown>;
  forceReply: (messageId: number, preview: string) => void;
}) {
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());
  const handledForceReplies = new Set<string>();

  const active = createMemo(() => {
    const peerId = options.activePeerId();
    const snapshot = options.snapshot();
    if (peerId === 'empty' || snapshot.activePeerId !== peerId) return undefined;
    for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
      const message = snapshot.messages[index];
      if (message?.botKeyboard?.kind === 'reply') {
        return { message, messageId: message.id, keyboard: message.botKeyboard };
      }
    }
    return undefined;
  });

  const visible = createMemo(() => {
    const current = active();
    if (!current || current.keyboard.hidden) return undefined;
    const key = `${options.activePeerId()}:${current.messageId}`;
    return dismissed().has(key) ? undefined : current;
  });

  const botStarted = createMemo(() => {
    const snapshot = options.snapshot();
    return (
      snapshot.messages.some(({ outgoing }) => outgoing) ||
      snapshot.pending.some(
        ({ peer, botStart }) => peer.id === options.activePeerId() && Boolean(botStart),
      )
    );
  });

  const dismissSingleUse = (owner: string) => {
    if (owner !== 'reply') return;
    const current = visible();
    if (!current?.keyboard.singleUse) return;
    const key = `${options.activePeerId()}:${current.messageId}`;
    setDismissed((currentDismissed) => new Set(currentDismissed).add(key));
  };

  createEffect(() => {
    const current = visible();
    if (!current?.keyboard.forceReply) return;
    const key = `${options.activePeerId()}:${current.messageId}`;
    if (handledForceReplies.has(key) || options.reply() || options.editing()) return;
    handledForceReplies.add(key);
    options.forceReply(
      current.messageId,
      current.message.text || current.message.media?.name || 'The bot requested a reply',
    );
  });

  return { visible, botStarted, dismissSingleUse };
}
