import { gapsAfterDeletion, gapsAfterInsertion } from '../core/peerHistories';
import { messageInSavedDialog } from '../savedMessages';
import { messageInTopic } from '../forums';
import type { ConversationViewSnapshot, EngineSnapshot, TelegramConversationEvent } from '../types';

type ConversationChange = Exclude<TelegramConversationEvent, { type: 'history-reset' }>;

/** Apply the same live-message rules to a published view and a delayed load result. */
export function applyConversationChange<View extends ConversationViewSnapshot>(
  view: View,
  event: ConversationChange,
): View {
  const peerId = view.activePeerId;
  if (!peerId) return view;
  let messages = view.messages;
  let historyGaps = view.historyGaps;
  let pinnedMessages = view.pinnedMessages;
  if (event.type === 'message-upsert') {
    if (event.message.peerId !== peerId) return view;
    if (
      (view.activeTopicId !== undefined && !messageInTopic(event.message, view.activeTopicId)) ||
      (view.activeSavedPeer !== undefined &&
        !messageInSavedDialog(event.message, view.activeSavedPeer.id))
    ) {
      if (![...messages, ...pinnedMessages].some(({ id }) => id === event.message.id)) return view;
      return {
        ...view,
        messages: messages.filter(({ id }) => id !== event.message.id),
        pinnedMessages: pinnedMessages.filter(({ id }) => id !== event.message.id),
      };
    }
    const messageId = event.message.id;
    const known = messages.some(({ id }) => id === messageId);
    const newestId = messages.at(-1)?.id ?? 0;
    // A message missing from inside the loaded range arrived out of order, for example when
    // a history page loaded between two updates. Only a declared gap may hide it.
    const insideLoadedRange =
      messageId > (messages[0]?.id ?? Number.POSITIVE_INFINITY) &&
      !view.historyGaps.some(
        (gap) => gap.olderMaxMessageId < messageId && messageId < gap.newerMinMessageId,
      );
    if (known || event.insertIfMissing || messageId > newestId || insideLoadedRange) {
      historyGaps = gapsAfterInsertion(historyGaps, messageId);
      messages = [...messages.filter(({ id }) => id !== messageId), event.message].sort(
        (left, right) => left.id - right.id,
      );
    }
    if (pinnedMessages.some(({ id }) => id === messageId))
      pinnedMessages = pinnedMessages.map((message) =>
        message.id === messageId ? event.message : message,
      );
  } else if (event.type === 'messages-delete') {
    if (event.peerId && event.peerId !== peerId) return view;
    const deleted = new Set(event.messageIds);
    messages = messages.filter(({ id }) => !deleted.has(id));
    pinnedMessages = pinnedMessages.filter(({ id }) => !deleted.has(id));
    historyGaps = gapsAfterDeletion(historyGaps, messages, deleted);
  } else {
    if (event.peerId !== peerId) return view;
    pinnedMessages = view.activeSavedPeer
      ? event.messages.filter((message) => messageInSavedDialog(message, view.activeSavedPeer!.id))
      : view.activeTopicId === undefined
        ? event.messages
        : event.messages.filter((message) => messageInTopic(message, view.activeTopicId!));
  }
  return messages === view.messages && pinnedMessages === view.pinnedMessages
    ? view
    : { ...view, messages, pinnedMessages, historyGaps };
}

interface VisibilityReport {
  readonly peerId: string;
  readonly visible: boolean;
  readonly atBottom: boolean;
}

interface ClientRecord {
  snapshot?: EngineSnapshot;
  seenAt?: number;
  visibility?: VisibilityReport;
  stateQueued?: boolean;
  conversationLoad?: { peerId: string; changes?: ConversationChange[] | undefined } | undefined;
}

/** Keeps each tab's projection, liveness, and visibility as one owned record. */
export function makeClientRegistry() {
  const records = new Map<string, ClientRecord>();

  const record = (clientId: string) => records.get(clientId) ?? {};

  return {
    touch(clientId: string, seenAt: number = Date.now()) {
      records.set(clientId, { ...record(clientId), seenAt });
    },
    setSnapshot(clientId: string, snapshot: EngineSnapshot) {
      const previous = record(clientId);
      records.set(clientId, {
        ...previous,
        snapshot,
        conversationLoad:
          previous.conversationLoad?.peerId === snapshot.activePeerId
            ? previous.conversationLoad
            : undefined,
      });
    },
    /** A new request supersedes older loads even when the peer is unchanged. */
    beginConversationLoad(clientId: string, peerId: string) {
      const request = { peerId, changes: [] as ConversationChange[] | undefined };
      records.set(clientId, { ...record(clientId), conversationLoad: request });
      const current = () => {
        const client = records.get(clientId);
        return client?.conversationLoad === request && client.snapshot?.activePeerId === peerId;
      };
      return {
        current,
        complete(view: ConversationViewSnapshot) {
          if (!current() || view.activePeerId !== peerId || !request.changes) return undefined;
          const changes = request.changes;
          request.changes = undefined;
          return changes.reduce(applyConversationChange, view);
        },
        cancel() {
          request.changes = undefined;
          if (records.get(clientId)?.conversationLoad === request)
            records.set(clientId, { ...record(clientId), conversationLoad: undefined });
        },
      };
    },
    recordConversationChange(event: ConversationChange) {
      const peerId = event.type === 'message-upsert' ? event.message.peerId : event.peerId;
      for (const { conversationLoad } of records.values())
        if (conversationLoad?.changes && (!peerId || conversationLoad.peerId === peerId))
          conversationLoad.changes.push(event);
    },
    hasSnapshot: (clientId: string) => records.get(clientId)?.snapshot !== undefined,
    snapshot: (clientId: string) => records.get(clientId)?.snapshot,
    *snapshots(): IterableIterator<[string, EngineSnapshot]> {
      for (const [clientId, value] of records) {
        if (value.snapshot) yield [clientId, value.snapshot];
      }
    },
    setVisibility(clientId: string, visibility: VisibilityReport, seenAt: number = Date.now()) {
      records.set(clientId, { ...record(clientId), seenAt, visibility });
    },
    visibilityReports(peerId: string, seenAfter: number) {
      const reports: VisibilityReport[] = [];
      for (const value of records.values()) {
        if ((value.seenAt ?? 0) >= seenAfter && value.visibility?.peerId === peerId) {
          reports.push(value.visibility);
        }
      }
      return reports;
    },
    visiblePeerIds() {
      return new Set(
        [...records.values()].flatMap(({ visibility }) => (visibility ? [visibility.peerId] : [])),
      );
    },
    queueState(clientId: string) {
      records.set(clientId, { ...record(clientId), stateQueued: true });
    },
    takeQueuedStateClients() {
      const queued: string[] = [];
      for (const [clientId, value] of records) {
        if (!value.stateQueued) continue;
        queued.push(clientId);
        records.set(clientId, { ...value, stateQueued: false });
      }
      return queued;
    },
    staleClientIds(seenBefore: number, preserveClientId: string) {
      return [...records.entries()]
        .filter(
          ([clientId, value]) => clientId !== preserveClientId && (value.seenAt ?? 0) < seenBefore,
        )
        .map(([clientId]) => clientId);
    },
    remove(clientId: string) {
      const peerId = records.get(clientId)?.visibility?.peerId;
      records.delete(clientId);
      return peerId;
    },
    clear: () => records.clear(),
  };
}
