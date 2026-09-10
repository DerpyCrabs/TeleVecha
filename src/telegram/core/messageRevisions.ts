import type { TelegramMessage } from '../types';

const messageKey = (peerId: string, messageId: number) => `${peerId}:${messageId}`;

/** Rejects message data fetched before a newer edit or deletion was observed. */
export function createMessageRevisions(capacity: number = 5_000) {
  const mutations = new Map<string, number>();
  let revision = 0;
  let floor = 0;
  const accepted = (peerId: string, messageId: number, requestRevision: number) =>
    requestRevision >= floor &&
    (mutations.get(messageKey(peerId, messageId)) ?? 0) <= requestRevision;

  return {
    capture: () => revision,
    record(peerId: string, messageId: number) {
      revision += 1;
      const key = messageKey(peerId, messageId);
      mutations.delete(key);
      mutations.set(key, revision);
      while (mutations.size > capacity) {
        const oldestKey = mutations.keys().next().value;
        if (oldestKey === undefined) break;
        floor = Math.max(floor, mutations.get(oldestKey) ?? 0);
        mutations.delete(oldestKey);
      }
    },
    filter: <Message extends TelegramMessage>(
      peerId: string,
      messages: Message[],
      requestRevision: number,
    ) => messages.filter(({ id }) => accepted(peerId, id, requestRevision)),
    merge(
      peerId: string,
      current: readonly TelegramMessage[],
      fetched: readonly TelegramMessage[],
      requestRevision: number,
    ) {
      const merged = new Map(current.map((message) => [message.id, message]));
      for (const message of fetched) {
        if (accepted(peerId, message.id, requestRevision)) merged.set(message.id, message);
      }
      return [...merged.values()].sort((left, right) => left.id - right.id);
    },
    clear: () => mutations.clear(),
  };
}
