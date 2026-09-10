import { Effect } from 'effect';
import { type DraftReservation, type LatestStateCache, type TimedCacheValue } from './store';
import type {
  CachedDialog,
  CachedMessage,
  PendingSend,
  SyncCursor,
  TelegramDraftDetails,
  TelegramGroupMember,
  TelegramMessage,
} from '../types';

const DEFAULT_MESSAGE_LOAD_LIMIT = 500;
const LEGACY_ACCOUNT_ID = 'legacy-unowned';

type SeededMap<T> = ReadonlyMap<string, T> | Readonly<Record<string, T>>;

export interface MemoryCacheStoreInitialState {
  transportSession?: unknown;
  accountId?: string | undefined;
  cursor?: SyncCursor | undefined;
  epoch?: number | undefined;
  dialogs?: readonly CachedDialog[] | undefined;
  messages?: readonly CachedMessage[] | undefined;
  drafts?: Readonly<Record<string, string>> | undefined;
  draftRevisions?: Readonly<Record<string, number>> | undefined;
  draftDetails?: Readonly<Record<string, TelegramDraftDetails>> | undefined;
  pending?: readonly PendingSend[] | undefined;
  pinned?: SeededMap<TimedCacheValue<TelegramMessage[]>> | undefined;
  pinnedMessages?: SeededMap<TimedCacheValue<TelegramMessage[]>> | undefined;
  groupMembers?: SeededMap<TimedCacheValue<TelegramGroupMember[]>> | undefined;
  metadata?: SeededMap<TimedCacheValue<unknown>> | undefined;
  blobs?: SeededMap<Blob> | undefined;
}

/**
 * An isolated CacheStore for tests.
 *
 * The store clones values at its boundary, just as IndexedDB does. Callers can
 * mutate fixtures and loaded values without changing the store's cached state.
 */ export function makeMemoryCacheStore(initialState: MemoryCacheStoreInitialState = {}) {
  let storedTransportSession: unknown = clone(initialState.transportSession);
  let storedAccountId: string | undefined = initialState.accountId;
  let storedCursor: SyncCursor | undefined = clone(initialState.cursor);
  let storedEpoch: number = initialState.epoch ?? 0;
  let storedDialogs: CachedDialog[] = [...clone(initialState.dialogs ?? [])];
  let storedMessages: CachedMessage[] = [...clone(initialState.messages ?? [])];
  let storedDrafts: Map<string, string> = new Map(Object.entries(clone(initialState.drafts ?? {})));
  let storedDraftRevisions: Map<string, number> = new Map(
    Object.entries(clone(initialState.draftRevisions ?? {})),
  );
  let storedDraftDetails: Map<string, TelegramDraftDetails> = new Map(
    Object.entries(clone(initialState.draftDetails ?? {})),
  );
  let storedPending: PendingSend[] = [...clone(initialState.pending ?? [])];
  let storedPinnedMessages: Map<string, TimedCacheValue<TelegramMessage[]>> = seedMap(
    initialState.pinnedMessages ?? initialState.pinned,
  );
  let storedGroupMembers: Map<string, TimedCacheValue<TelegramGroupMember[]>> = seedMap(
    initialState.groupMembers,
  );
  let storedMetadata: Map<string, TimedCacheValue<unknown>> = seedMap(initialState.metadata);
  let storedBlobs: Map<string, Blob> = seedMap(initialState.blobs);
  function loadTransportSessionInternal() {
    return Effect.sync(() => clone(storedTransportSession));
  }
  function saveTransportSession(session: unknown) {
    return Effect.sync(() => {
      storedTransportSession = clone(session);
    });
  }
  function clearAccountData() {
    return Effect.sync(() => {
      storedTransportSession = undefined;
      storedAccountId = undefined;
      storedCursor = undefined;
      storedEpoch = 0;
      storedDialogs = [];
      storedMessages = [];
      storedDrafts.clear();
      storedDraftRevisions.clear();
      storedDraftDetails.clear();
      storedPending = [];
      storedPinnedMessages.clear();
      storedGroupMembers.clear();
      storedMetadata.clear();
      storedBlobs.clear();
    });
  }
  function clearCacheData() {
    return Effect.sync(() => {
      storedCursor = undefined;
      storedEpoch = 0;
      storedDialogs = [];
      storedMessages = [];
      storedPinnedMessages.clear();
      storedGroupMembers.clear();
      storedMetadata.clear();
      storedBlobs.clear();
    });
  }
  function prepareOutboxWrite(_bytes: number, _forceEviction: boolean = false) {
    return Effect.sync(() => {
      // Memory-backed writes have no storage quota to reserve.
    });
  }
  function loadAccountId() {
    return Effect.sync(() => {
      return storedAccountId;
    });
  }
  function claimAccount(accountId: string) {
    return Effect.sync(() => {
      storedAccountId = accountId;
      storedPending = storedPending.map((send) =>
        send.accountId === undefined ? { ...send, accountId } : send,
      );
    });
  }
  function resetForAccount(accountId: string) {
    return Effect.sync(() => {
      const previousAccountId = storedAccountId;
      storedAccountId = accountId;
      storedCursor = undefined;
      storedEpoch = 0;
      storedDialogs = [];
      storedMessages = [];
      storedDrafts.clear();
      storedDraftRevisions.clear();
      storedDraftDetails.clear();
      storedPinnedMessages.clear();
      storedGroupMembers.clear();
      storedMetadata.clear();
      storedBlobs.clear();
      storedPending = storedPending.map((send) =>
        send.accountId === undefined
          ? {
              ...send,
              accountId: previousAccountId ?? LEGACY_ACCOUNT_ID,
              lastError: 'Queued for a different Telegram account.',
            }
          : send,
      );
    });
  }
  function loadCursor() {
    return Effect.sync(() => {
      return clone(storedCursor);
    });
  }
  function saveCursor(cursor: SyncCursor) {
    return Effect.sync(() => {
      storedCursor = clone(cursor);
    });
  }
  function loadEpoch() {
    return Effect.sync(() => {
      return storedEpoch;
    });
  }
  function beginNewEpoch() {
    return Effect.sync(() => {
      storedEpoch += 1;
      return storedEpoch;
    });
  }
  function commitLatestState(state: LatestStateCache) {
    return Effect.sync(() => {
      const snapshot = clone(state);
      const epoch = storedEpoch + 1;
      const dialogs = snapshot.dialogs.map((dialog) => ({ ...dialog, cacheEpoch: epoch }));
      storedEpoch = epoch;
      storedCursor = snapshot.cursor;
      storedDialogs = dialogs;
      storedMessages = [];
      for (const key of snapshot.discardBlobKeys ?? []) storedBlobs.delete(key);
      for (const key of snapshot.discardMetadataKeys ?? []) storedMetadata.delete(key);
      return epoch;
    });
  }
  function loadWorkspace() {
    return Effect.sync(() => {
      return {
        accountId: storedAccountId,
        dialogs: clone(storedDialogs),
        drafts: Object.fromEntries(storedDrafts),
        draftDetails: Object.fromEntries(storedDraftDetails),
        draftRevisions: Object.fromEntries(storedDraftRevisions),
        pending: sortedPending(),
        epoch: storedEpoch,
      };
    });
  }
  function loadDialogs() {
    return Effect.sync(() => {
      return clone(storedDialogs);
    });
  }
  function replaceDialogs(dialogs: CachedDialog[]) {
    return Effect.sync(() => {
      storedDialogs = clone(dialogs);
    });
  }
  function putDialog(dialog: CachedDialog) {
    return Effect.sync(() => {
      const next = clone(dialog);
      storedDialogs = [...storedDialogs.filter(({ peer }) => peer.id !== next.peer.id), next];
    });
  }
  function loadMessages(peerId: string, limit: number = DEFAULT_MESSAGE_LOAD_LIMIT) {
    return Effect.sync(() => {
      const requested = normalizeLimit(limit);
      if (requested === 0) return [];
      const messages = storedMessages
        .filter((message) => message.peerId === peerId)
        .sort((left, right) => left.id - right.id)
        .slice(-requested);
      return clone(messages);
    });
  }
  function loadMessagesBefore(
    peerId: string,
    beforeMessageId: number,
    limit: number = DEFAULT_MESSAGE_LOAD_LIMIT,
  ) {
    return Effect.sync(() => {
      const requested = normalizeLimit(limit);
      if (requested === 0) return [];
      const messages = storedMessages
        .filter((message) => message.peerId === peerId && message.id < beforeMessageId)
        .sort((left, right) => left.id - right.id)
        .slice(-requested);
      return clone(messages);
    });
  }
  function loadMessage(peerId: string, messageId: number) {
    return Effect.sync(() => {
      const message = storedMessages.find(
        (candidate) => candidate.peerId === peerId && candidate.id === messageId,
      );
      return clone(message);
    });
  }
  function replaceMessages(peerId: string, messages: CachedMessage[]) {
    return Effect.sync(() => {
      const replacements = clone(messages);
      storedMessages = [
        ...storedMessages.filter((message) => message.peerId !== peerId),
        ...replacements,
      ];
    });
  }
  function putMessages(messages: CachedMessage[]) {
    return Effect.sync(() => {
      const replacements = clone(messages);
      let nextMessages = storedMessages;
      for (const replacement of replacements) {
        const replacementKey = messageKey(replacement.peerId, replacement.id);
        nextMessages = [
          ...nextMessages.filter(
            (message) => messageKey(message.peerId, message.id) !== replacementKey,
          ),
          replacement,
        ];
      }
      storedMessages = nextMessages;
    });
  }
  const putMessage = Effect.fn('MemoryCacheStore.putMessage')(function* (message: CachedMessage) {
    yield* putMessages([message]);
  });
  function findMessagePeers(messageIds: number[]) {
    return Effect.sync(() => {
      const ids = new Set(messageIds);
      return [
        ...new Set(
          storedMessages.filter((message) => ids.has(message.id)).map(({ peerId }) => peerId),
        ),
      ];
    });
  }
  function deleteMessages(peerId: string, messageIds: number[]) {
    return Effect.sync(() => {
      const ids = new Set(messageIds);
      storedMessages = storedMessages.filter(
        (message) => message.peerId !== peerId || !ids.has(message.id),
      );
    });
  }
  function loadPinnedMessages(peerId: string) {
    return Effect.sync(() => {
      return clone(storedPinnedMessages.get(peerId));
    });
  }
  function savePinnedMessages(peerId: string, messages: TelegramMessage[]) {
    return Effect.sync(() => {
      storedPinnedMessages.set(peerId, { value: clone(messages), savedAt: Date.now() });
    });
  }
  function deletePinnedMessages(peerId: string) {
    return Effect.sync(() => {
      storedPinnedMessages.delete(peerId);
    });
  }
  function loadGroupMembers(peerId: string) {
    return Effect.sync(() => {
      return clone(storedGroupMembers.get(peerId));
    });
  }
  function saveGroupMembers(peerId: string, members: TelegramGroupMember[]) {
    return Effect.sync(() => {
      storedGroupMembers.set(peerId, { value: clone(members), savedAt: Date.now() });
    });
  }
  function deleteGroupMembers(peerId: string) {
    return Effect.sync(() => {
      storedGroupMembers.delete(peerId);
    });
  }
  function loadMetadata<Value>(key: string) {
    return Effect.sync(() => clone(storedMetadata.get(key) as TimedCacheValue<Value> | undefined));
  }
  function saveMetadata<Value>(key: string, value: Value) {
    return Effect.sync(() => {
      storedMetadata.set(key, { value: clone(value), savedAt: Date.now() });
    });
  }
  function deleteMetadata(key: string) {
    return Effect.sync(() => {
      storedMetadata.delete(key);
    });
  }
  function loadDrafts() {
    return Effect.sync(() => {
      return Object.fromEntries(storedDrafts);
    });
  }
  function loadDraftRevisions() {
    return Effect.sync(() => {
      return Object.fromEntries(storedDraftRevisions);
    });
  }
  function saveDraft(
    peerId: string,
    text: string,
    revision: number = 0,
    details?: TelegramDraftDetails,
  ) {
    return Effect.sync(() => {
      if (text || details) {
        storedDrafts.set(peerId, text);
        storedDraftRevisions.set(peerId, revision);
        if (details) storedDraftDetails.set(peerId, clone(details));
        else storedDraftDetails.delete(peerId);
        return;
      }
      storedDrafts.delete(peerId);
      storedDraftRevisions.delete(peerId);
      storedDraftDetails.delete(peerId);
    });
  }
  function loadOutbox() {
    return Effect.sync(() => {
      return sortedPending();
    });
  }
  function commitOutbox(sends: PendingSend | PendingSend[], draft?: DraftReservation) {
    return Effect.sync(() => {
      const batch = clone(Array.isArray(sends) ? sends : [sends]);
      if (batch.length === 0) return;

      const ids = new Set(batch.map(({ id }) => id));
      storedPending = [...storedPending.filter(({ id }) => !ids.has(id)), ...batch];
      if (
        draft &&
        storedDrafts.get(draft.peerId) === draft.text &&
        (storedDraftRevisions.get(draft.peerId) ?? 0) === (draft.revision ?? 0)
      ) {
        storedDrafts.delete(draft.peerId);
        storedDraftRevisions.delete(draft.peerId);
        storedDraftDetails.delete(draft.peerId);
      }
    });
  }
  function deletePending(id: string) {
    return Effect.sync(() => {
      storedPending = storedPending.filter((send) => send.id !== id);
    });
  }
  function loadBlob(key: string) {
    return Effect.sync(() => {
      return clone(storedBlobs.get(key));
    });
  }
  function saveBlob(key: string, blob: Blob) {
    return Effect.sync(() => {
      storedBlobs.set(key, clone(blob));
    });
  }
  function deleteBlob(key: string) {
    return Effect.sync(() => {
      storedBlobs.delete(key);
    });
  }
  function sortedPending() {
    return clone(storedPending).sort((left, right) => {
      if (
        left.peer.id === right.peer.id &&
        left.queueOrder !== undefined &&
        right.queueOrder !== undefined &&
        left.queueOrder !== right.queueOrder
      ) {
        return left.queueOrder - right.queueOrder;
      }
      return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
    });
  }
  return {
    get loadTransportSession() {
      return loadTransportSessionInternal();
    },
    saveTransportSession: saveTransportSession,
    clearAccountData: clearAccountData,
    clearCacheData: clearCacheData,
    prepareOutboxWrite: prepareOutboxWrite,
    loadAccountId: loadAccountId,
    claimAccount: claimAccount,
    resetForAccount: resetForAccount,
    loadCursor: loadCursor,
    saveCursor: saveCursor,
    loadEpoch: loadEpoch,
    beginNewEpoch: beginNewEpoch,
    commitLatestState: commitLatestState,
    loadWorkspace: loadWorkspace,
    loadDialogs: loadDialogs,
    replaceDialogs: replaceDialogs,
    putDialog: putDialog,
    loadMessages: loadMessages,
    loadMessagesBefore: loadMessagesBefore,
    loadMessage: loadMessage,
    replaceMessages: replaceMessages,
    putMessages: putMessages,
    putMessage: putMessage,
    findMessagePeers: findMessagePeers,
    deleteMessages: deleteMessages,
    loadPinnedMessages: loadPinnedMessages,
    savePinnedMessages: savePinnedMessages,
    deletePinnedMessages: deletePinnedMessages,
    loadGroupMembers: loadGroupMembers,
    saveGroupMembers: saveGroupMembers,
    deleteGroupMembers: deleteGroupMembers,
    loadMetadata: loadMetadata,
    saveMetadata: saveMetadata,
    deleteMetadata: deleteMetadata,
    loadDrafts: loadDrafts,
    loadDraftRevisions: loadDraftRevisions,
    saveDraft: saveDraft,
    loadOutbox: loadOutbox,
    commitOutbox: commitOutbox,
    deletePending: deletePending,
    loadBlob: loadBlob,
    saveBlob: saveBlob,
    deleteBlob: deleteBlob,
  };
}
export type MemoryCacheStore = ReturnType<typeof makeMemoryCacheStore>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function seedMap<T>(values?: SeededMap<T>): Map<string, T> {
  if (!values) return new Map();
  const entries: [string, T][] =
    values instanceof Map
      ? [...(values as ReadonlyMap<string, T>).entries()]
      : Object.entries(values as Readonly<Record<string, T>>);
  return new Map(clone(entries));
}

function normalizeLimit(limit: number) {
  if (!Number.isFinite(limit)) return limit > 0 ? Number.MAX_SAFE_INTEGER : 0;
  return Math.max(0, Math.floor(limit));
}

function messageKey(peerId: string, messageId: number) {
  return `${peerId.length}:${peerId}:${messageId}`;
}
