export const MAX_VISIBLE_UNREAD_COUNT = 999;

export function normalizeUnreadCount(count: number) {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.floor(count));
}

export function formatUnreadCount(count: number) {
  const normalized = normalizeUnreadCount(count);
  return normalized > MAX_VISIBLE_UNREAD_COUNT
    ? `${MAX_VISIBLE_UNREAD_COUNT}+`
    : String(normalized);
}

export function describeUnreadCount(count: number) {
  const normalized = normalizeUnreadCount(count);
  return `${normalized} unread ${normalized === 1 ? 'message' : 'messages'}`;
}
