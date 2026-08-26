interface GroupedMessage {
  groupedId?: string | undefined;
}

export function albumSafeMessageWindow(
  messages: readonly GroupedMessage[],
  requestedStart: number,
  limit: number,
) {
  const lastStart = Math.max(0, messages.length - limit);
  const clampedStart = Math.max(0, Math.min(requestedStart, lastStart));
  let start = clampedStart;
  let end = Math.min(messages.length, clampedStart + limit);
  const firstGroupedId = messages[start]?.groupedId;
  while (firstGroupedId && start > 0 && messages[start - 1]?.groupedId === firstGroupedId) {
    start -= 1;
  }

  const lastGroupedId = messages[end - 1]?.groupedId;
  while (lastGroupedId && messages[end]?.groupedId === lastGroupedId) end += 1;
  return { start, end };
}
