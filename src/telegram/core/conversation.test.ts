import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import type { EngineSnapshot, TelegramDialog } from '../types';
import { makeConversation } from './conversation';

const peer = { id: 'u:1', kind: 'user' as const };
const dialog: TelegramDialog = {
  peer,
  title: 'Mira',
  initials: 'M',
  color: '#000',
  topMessageId: 0,
  unreadCount: 0,
  readInboxMaxId: 0,
  readOutboxMaxId: 0,
  muted: false,
  pinned: false,
  archived: false,
  hasAvatar: false,
};

function snapshot(activePeerId: string | undefined): EngineSnapshot {
  return {
    phase: 'ready',
    sync: 'current',
    online: true,
    dialogs: [dialog],
    activePeerId,
    messages: [],
    drafts: {},
    draftDetails: {},
    pending: [],
    loadingMessages: false,
    hasOlderMessages: false,
    loadingOlderMessages: false,
    pinnedMessages: [],
    historyGaps: [],
    activities: [],
  };
}

describe('Conversation', () => {
  it('keeps commands bound to their peer after selection changes', async () => {
    let current = snapshot(peer.id);
    const succeed = <A>(value: A) => vi.fn(() => Effect.succeed(value));
    const sendDraft = succeed(undefined);
    const host = {
      snapshot: () => current,
      setDraft: succeed(undefined),
      setTyping: succeed(undefined),
      sendDraft,
      sendAttachments: succeed(undefined),
      editMessage: succeed(undefined),
      getBotCommands: succeed([]),
      searchGifs: succeed([]),
      startBot: succeed(undefined),
      answerBotCallback: succeed(undefined),
      requestUrlAuth: succeed(undefined),
      acceptUrlAuth: succeed(undefined),
      sendSticker: succeed(undefined),
      toggleReaction: succeed(undefined),
      deleteMessage: succeed(undefined),
      openMessageInConversationView: succeed({
        conversation: {
          activePeerId: peer.id,
          messages: [],
          loadingMessages: false,
          hasOlderMessages: false,
          loadingOlderMessages: false,
          pinnedMessages: [],
          historyGaps: [],
        },
        found: true,
      }),
      loadOlderConversationView: succeed({
        activePeerId: peer.id,
        messages: [],
        loadingMessages: false,
        hasOlderMessages: false,
        loadingOlderMessages: false,
        pinnedMessages: [],
        historyGaps: [],
      }),
      retryConversationView: succeed({
        activePeerId: peer.id,
        messages: [],
        loadingMessages: false,
        hasOlderMessages: false,
        loadingOlderMessages: false,
        pinnedMessages: [],
        historyGaps: [],
      }),
      loadHistoryGapConversationView: succeed({
        activePeerId: peer.id,
        messages: [],
        loadingMessages: false,
        hasOlderMessages: false,
        loadingOlderMessages: false,
        pinnedMessages: [],
        historyGaps: [],
      }),
      searchConversationMessages: succeed({ messages: [], hasMore: false }),
      getConversationSharedMedia: succeed({ messages: [], hasMore: false }),
      forwardMessage: succeed(undefined),
      getUserDetails: succeed({ blocked: false, contact: false }),
      setBlocked: succeed(undefined),
      setPinnedMessage: succeed(undefined),
    };
    const conversation = makeConversation(host, peer);

    await Effect.runPromise(conversation.sendDraft('hello'));
    expect(sendDraft).toHaveBeenCalledWith(peer, 'hello', undefined, undefined);
    await Effect.runPromise(conversation.searchGifs('cat'));
    expect(host.searchGifs).toHaveBeenCalledWith(peer, 'cat');

    current = snapshot('u:2');
    await Effect.runPromise(conversation.sendDraft('still addressed to Mira'));
    expect(sendDraft).toHaveBeenLastCalledWith(
      peer,
      'still addressed to Mira',
      undefined,
      undefined,
    );
    await expect(Effect.runPromise(conversation.loadOlder())).rejects.toThrow('no longer selected');
  });
});
