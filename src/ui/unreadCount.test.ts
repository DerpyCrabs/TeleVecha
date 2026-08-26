import { describe, expect, it } from 'vitest';

import {
  MAX_VISIBLE_UNREAD_COUNT,
  describeUnreadCount,
  formatUnreadCount,
  normalizeUnreadCount,
} from './unreadCount';

describe('unread count formatting', () => {
  it('keeps ordinary counts intact and caps only the visible value', () => {
    expect(formatUnreadCount(1)).toBe('1');
    expect(formatUnreadCount(MAX_VISIBLE_UNREAD_COUNT)).toBe('999');
    expect(formatUnreadCount(MAX_VISIBLE_UNREAD_COUNT + 1)).toBe('999+');
    expect(describeUnreadCount(MAX_VISIBLE_UNREAD_COUNT + 1)).toBe('1000 unread messages');
  });

  it('normalizes invalid values before rendering them', () => {
    expect(normalizeUnreadCount(-4)).toBe(0);
    expect(normalizeUnreadCount(2.9)).toBe(2);
    expect(normalizeUnreadCount(Number.NaN)).toBe(0);
    expect(describeUnreadCount(1)).toBe('1 unread message');
  });
});
