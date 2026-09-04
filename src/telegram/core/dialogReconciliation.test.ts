import { describe, expect, it } from 'vitest';

import type { TelegramDialog } from '../types';
import { reconcileDialogPage } from './dialogReconciliation';

const dialog = (id: string, title: string, topMessageId = 1): TelegramDialog => ({
  peer: { id, kind: 'user' },
  title,
  initials: title[0] ?? '?',
  color: '#000',
  topMessageId,
  unreadCount: 0,
  readInboxMaxId: 0,
  readOutboxMaxId: 0,
  muted: false,
  pinned: false,
  hasAvatar: false,
});

describe('dialogReconciliation', () => {
  it('keeps the complete live dialog when it changed during a fetch', () => {
    const before = dialog('peer-1', 'Before', 1);
    const live = { ...before, title: 'Live', topMessageId: 3, unreadCount: 2, muted: true };
    const result = reconcileDialogPage(
      [dialog('peer-1', 'Stale server', 1)],
      [live],
      new Map([['peer-1', { version: 1 }]]),
      () => 2,
    );

    expect(result).toEqual([live]);
  });

  it('retains a dialog that arrived after the fetch began', () => {
    const arrived = dialog('peer-2', 'Arrived', 4);
    const result = reconcileDialogPage([], [arrived], new Map(), () => 1);

    expect(result).toEqual([arrived]);
  });

  it('does not resurrect a dialog deleted while the fetch was running', () => {
    const result = reconcileDialogPage(
      [dialog('peer-1', 'Stale server')],
      [],
      new Map([['peer-1', { version: 1 }]]),
      () => 2,
    );

    expect(result).toEqual([]);
  });

  it('preserves live presence when a dialog refresh omits presence metadata', () => {
    const current = {
      ...dialog('peer-1', 'Alice'),
      presence: 'offline' as const,
      lastSeenAt: 1_725_470_400,
    };

    const [result] = reconcileDialogPage(
      [dialog('peer-1', 'Alice')],
      [current],
      new Map([['peer-1', { version: 1 }]]),
      () => 1,
    );

    expect(result).toMatchObject({ presence: 'offline', lastSeenAt: 1_725_470_400 });
  });
});
