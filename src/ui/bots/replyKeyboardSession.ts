import type { Snapshot } from 'effectweb';
import type { EngineSnapshot } from '../../telegram/types';
import type { Read } from 'effectweb/session';
import { lifetime } from 'effectweb/session';
import { program } from 'effectweb';
/** Owns reply-keyboard visibility, single-use dismissal, and forced replies. */
export function createReplyKeyboardSession(options: {
  snapshot: Read<Snapshot<EngineSnapshot>>;
  activePeerId: Read<string>;
  reply: Read<unknown>;
  editing: Read<unknown>;
  forceReply: (messageId: number, preview: string) => void;
}) {
  const scope = lifetime();
  type ReplyKeyboardSessionModel = { dismissed: ReadonlySet<string> };
  type ReplyKeyboardSessionMessage = { type: 'Dismissed'; value: ReadonlySet<string> };
  const state = program<ReplyKeyboardSessionModel, ReplyKeyboardSessionMessage>({
    initial: { dismissed: new Set() },
    update: (model, message) => {
      switch (message.type) {
        case 'Dismissed':
          return {
            model: Object.is(model.dismissed, message.value)
              ? model
              : { ...model, dismissed: message.value },
          };
      }
    },
  });
  const handledForceReplies = new Set<string>();
  const active = () => {
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
  };
  const visible = () => {
    const current = active();
    if (!current || current.keyboard.hidden) return undefined;
    const key = `${options.activePeerId()}:${current.messageId}`;
    return state.model().dismissed.has(key) ? undefined : current;
  };
  const botStarted = () => {
    const snapshot = options.snapshot();
    if (snapshot.activePeerId !== options.activePeerId()) return false;
    return (
      snapshot.messages.some(({ outgoing }) => outgoing) ||
      snapshot.pending.some(
        ({ peer, botStart }) => peer.id === options.activePeerId() && Boolean(botStart),
      )
    );
  };
  const dismissSingleUse = (owner: string) => {
    if (owner !== 'reply') return;
    const current = visible();
    if (!current?.keyboard.singleUse) return;
    const key = `${options.activePeerId()}:${current.messageId}`;
    state.send({
      type: 'Dismissed',
      value: ((currentDismissed) => new Set(currentDismissed).add(key))(state.model().dismissed),
    });
  };
  const refresh = () => {
    const current = visible();
    if (!current?.keyboard.forceReply) return;
    const key = `${options.activePeerId()}:${current.messageId}`;
    if (handledForceReplies.has(key) || options.reply() || options.editing()) return;
    handledForceReplies.add(key);
    options.forceReply(
      current.messageId,
      current.message.text || current.message.media?.name || 'The bot requested a reply',
    );
  };
  const actions = { refresh, dismissSingleUse };
  return {
    ...actions,
    model: state.model,
    subscribe: state.subscribe,
    dispose: () => {
      scope.dispose();
      state.dispose();
    },
    snapshot: () => ({ ...actions, visible: visible(), botStarted: botStarted() }),
  };
}
