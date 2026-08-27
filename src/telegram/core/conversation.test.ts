import { describe, expect, it, vi } from 'vitest';

import type { EngineSnapshot, TelegramDialog } from '../types';
import { Conversation } from './conversation';

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
  it('binds peer identity and rejects commands after selection changes', async () => {
    let current = snapshot(peer.id);
    const sendDraft = vi.fn(async () => undefined);
    const host = {
      snapshot: () => current,
      setDraft: vi.fn(async () => undefined),
      setTyping: vi.fn(async () => undefined),
      sendDraft,
      sendAttachments: vi.fn(async () => undefined),
      editMessage: vi.fn(async () => undefined),
      getBotCommands: vi.fn(async () => []),
      startBot: vi.fn(async () => undefined),
      answerBotCallback: vi.fn(async () => undefined),
      requestUrlAuth: vi.fn(async () => undefined),
      acceptUrlAuth: vi.fn(async () => undefined),
      sendSticker: vi.fn(async () => undefined),
      toggleReaction: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      openMessage: vi.fn(async () => true),
      loadOlderMessages: vi.fn(async () => undefined),
      retryHistory: vi.fn(async () => undefined),
      loadHistoryGap: vi.fn(async () => undefined),
      searchMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
      getSharedMedia: vi.fn(async () => ({ messages: [], hasMore: false })),
      forwardMessage: vi.fn(async () => undefined),
      getUserDetails: vi.fn(async () => ({ blocked: false, contact: false })),
      setBlocked: vi.fn(async () => undefined),
      setPinnedMessage: vi.fn(async () => undefined),
    };
    const conversation = new Conversation(host, peer.id);

    await conversation.sendDraft('hello');
    expect(sendDraft).toHaveBeenCalledWith(peer, 'hello', undefined, undefined);

    current = snapshot('u:2');
    expect(() => conversation.sendDraft('stale')).toThrow('no longer selected');
  });
});
