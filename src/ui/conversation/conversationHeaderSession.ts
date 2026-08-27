import { createMemo, createSignal, type Accessor } from 'solid-js';

import type { ChatSummary } from '../../domain/models';
import type { EngineSnapshot } from '../../telegram/types';

function lastSeenStatus(timestamp: number) {
  const seen = new Date(timestamp * 1000);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(seen);
  if (seen.toDateString() === today.toDateString()) return `last seen today at ${time}`;
  if (seen.toDateString() === yesterday.toDateString()) return `last seen yesterday at ${time}`;
  return `last seen ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(seen)}`;
}

/** Derives conversation-header status and owns pinned-message navigation. */
export function createConversationHeaderSession(options: {
  snapshot: Accessor<EngineSnapshot>;
  chat: Accessor<ChatSummary>;
  activePeerId: Accessor<string>;
  activePeerMatches: Accessor<boolean>;
  online: Accessor<boolean>;
}) {
  const [pinnedSelection, setPinnedSelection] = createSignal({
    peerId: '',
    setKey: '',
    index: 0,
  });
  const activity = createMemo(() =>
    options.snapshot().activities.find(({ peerId }) => peerId === options.activePeerId()),
  );
  const status = createMemo(() => {
    const chat = options.chat();
    const snapshot = options.snapshot();
    if (chat.id === 'empty') return 'Choose a chat';
    if (snapshot.phase === 'connecting') return 'connecting…';
    if (snapshot.phase === 'syncing') return 'syncing…';
    if (!options.online()) return 'offline · cached conversation';
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
  });
  const pinnedIndex = createMemo(() => {
    const messages = options.snapshot().pinnedMessages;
    const selection = pinnedSelection();
    const setKey = messages.map(({ id }) => id).join(',');
    if (
      selection.peerId !== options.activePeerId() ||
      selection.setKey !== setKey ||
      messages.length === 0
    ) {
      return 0;
    }
    return Math.min(selection.index, messages.length - 1);
  });
  const pinnedMessage = createMemo(() =>
    options.activePeerMatches() ? options.snapshot().pinnedMessages[pinnedIndex()] : undefined,
  );
  const setPinnedIndex = (index: number | ((previous: number) => number)) => {
    const previous = pinnedIndex();
    setPinnedSelection({
      peerId: options.activePeerId(),
      setKey: options
        .snapshot()
        .pinnedMessages.map(({ id }) => id)
        .join(','),
      index: typeof index === 'function' ? index(previous) : index,
    });
  };

  return { status, pinnedMessage, pinnedIndex, setPinnedIndex };
}
