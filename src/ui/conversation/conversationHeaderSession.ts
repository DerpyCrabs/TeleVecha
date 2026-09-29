import type { Snapshot } from 'effectweb';
import { lifetime, program } from 'effectweb';
import type { ChatSummary } from '../../domain/models';
import type { EngineSnapshot } from '../../telegram/types';
function lastSeenStatus(timestamp: number) {
  const seen = new Date(timestamp * 1000);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    seen,
  );
  if (seen.toDateString() === today.toDateString()) return `last seen today at ${time}`;
  if (seen.toDateString() === yesterday.toDateString()) return `last seen yesterday at ${time}`;
  return `last seen ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    seen,
  )}`;
}

/** Derives conversation-header status and owns pinned-message navigation. */
export function createConversationHeaderSession(options: {
  snapshot: () => Snapshot<EngineSnapshot>;
  chat: () => ChatSummary;
  activePeerId: () => string;
  activePeerMatches: () => boolean;
}) {
  const scope = lifetime();
  type ConversationHeaderSessionModel = {
    pinnedSelection: { peerId: string; setKey: string; index: number };
  };
  type ConversationHeaderSessionMessage = {
    type: 'PinnedSelection';
    value: { peerId: string; setKey: string; index: number };
  };
  const state = program<ConversationHeaderSessionModel, ConversationHeaderSessionMessage>({
    initial: { pinnedSelection: { peerId: '', setKey: '', index: 0 } },
    update: (model, message) => {
      switch (message.type) {
        case 'PinnedSelection':
          return {
            model: Object.is(model.pinnedSelection, message.value)
              ? model
              : { ...model, pinnedSelection: message.value },
          };
      }
    },
  });
  const activity = () =>
    options.snapshot().activities.find(({ peerId }) => peerId === options.activePeerId());
  const status = () => {
    const chat = options.chat();
    if (chat.id === 'empty') return 'Choose a chat';
    const currentActivity = activity();
    if (currentActivity?.kind === 'typing') return 'typing…';
    if (currentActivity?.kind === 'uploading') return 'uploading…';
    if (currentActivity?.kind === 'recording') return 'recording…';
    if (currentActivity?.kind === 'choosing-sticker') return 'choosing a sticker…';
    if (chat.kind === 'channel') return 'channel';
    if (chat.kind === 'group') return 'group';
    if (chat.presence === 'online') return 'online';
    if (chat.lastSeenAt) return lastSeenStatus(chat.lastSeenAt);
    if (chat.presence === 'recently') return 'last seen recently';
    if (chat.presence === 'offline') return 'offline';
    return chat.kind === 'user' ? 'status unavailable' : '';
  };
  const pinnedIndex = () => {
    const messages = options.snapshot().pinnedMessages;
    const selection = state.model().pinnedSelection;
    const setKey = messages.map(({ id }) => id).join(',');
    if (
      selection.peerId !== options.activePeerId() ||
      selection.setKey !== setKey ||
      messages.length === 0
    ) {
      return 0;
    }
    return Math.min(selection.index, messages.length - 1);
  };
  const pinnedMessage = () =>
    options.activePeerMatches() ? options.snapshot().pinnedMessages[pinnedIndex()] : undefined;
  const setPinnedIndex = (index: number | ((previous: number) => number)) => {
    const previous = pinnedIndex();
    state.send({
      type: 'PinnedSelection',
      value: {
        peerId: options.activePeerId(),
        setKey: options
          .snapshot()
          .pinnedMessages.map(({ id }) => id)
          .join(','),
        index: typeof index === 'function' ? index(previous) : index,
      },
    });
  };
  const actions = { setPinnedIndex };
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
      status: status(),
      pinnedMessage: pinnedMessage(),
      pinnedIndex: pinnedIndex(),
    }),
  };
}
