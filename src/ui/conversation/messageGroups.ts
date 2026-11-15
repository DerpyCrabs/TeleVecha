interface GroupedMessage {
  id: string;
  outgoing: boolean;
  groupedId?: string | undefined;
}

/** The unread boundary can be inside an album whose continuation rows are hidden. */
export function firstUnreadRow<T extends GroupedMessage>(
  messages: readonly T[],
  afterId: number,
): T | undefined {
  let index = messages.findIndex((message) => !message.outgoing && Number(message.id) > afterId);
  if (index < 0) return undefined;
  const group = messages[index]!.groupedId;
  while (group && index > 0 && messages[index - 1]?.groupedId === group) index--;
  return messages[index];
}
