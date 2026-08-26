import { describe, expect, it } from 'vitest';

import type {
  EngineSnapshot,
  PendingSend,
  TelegramDialog,
  TelegramMessage,
} from '../../telegram/types';
import { presentConversation } from './conversationPresentation';

const peer = { id: 'user:1', kind: 'user' as const };
const dialog: TelegramDialog = {
  peer,
  title: 'Alice',
  initials: 'A',
  color: '#123456',
  unreadCount: 0,
  muted: false,
  pinned: false,
  topMessageId: 1,
  readInboxMaxId: 1,
  readOutboxMaxId: 1,
  hasAvatar: false,
};

function snapshot(messages: TelegramMessage[] = [], pending: PendingSend[] = []): EngineSnapshot {
  return {
    phase: 'ready',
    sync: 'current',
    online: true,
    dialogs: [dialog],
    activePeerId: peer.id,
    messages,
    drafts: {},
    pending,
    loadingMessages: false,
    hasOlderMessages: false,
    loadingOlderMessages: false,
    pinnedMessages: [],
    historyGaps: [],
    activities: [],
    expressionRevision: 0,
    botCommandsRevision: 0,
  };
}

function queued(overrides: Partial<PendingSend> = {}): PendingSend {
  return {
    id: 'pending-1',
    peer,
    text: 'Queued',
    randomId: 'random-1',
    createdAt: 1_700_000_000_000,
    attempts: 0,
    ...overrides,
  };
}

describe('presentConversation', () => {
  it('replaces a queued view once Telegram confirms its random id', () => {
    const confirmed: TelegramMessage = {
      id: 5,
      peerId: peer.id,
      senderId: peer.id,
      text: 'Queued',
      date: 1_700_000_001,
      outgoing: true,
      randomId: 'random-1',
    };

    const result = presentConversation(snapshot([confirmed], [queued()]), peer.id);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: `${peer.id}:random:random-1`,
      message: { id: '5', status: 'sent' },
    });
  });

  it('presents an attachment batch as one pending album', () => {
    const attachment = (randomId: string) => ({
      blob: new Blob([randomId]),
      name: `${randomId}.png`,
      mimeType: 'image/png',
      asSticker: false,
      sendAs: 'media' as const,
      randomId,
    });
    const result = presentConversation(
      snapshot([], [queued({ album: { attachments: [attachment('one'), attachment('two')] } })]),
      peer.id,
    );

    expect(result.map(({ message }) => message.groupedId)).toEqual([
      'pending:pending-1',
      'pending:pending-1',
    ]);
    expect(result.map(({ message }) => message.body)).toEqual(['Queued', '']);
  });

  it('returns no messages for an inactive peer', () => {
    expect(presentConversation(snapshot(), 'user:2')).toEqual([]);
  });
});
