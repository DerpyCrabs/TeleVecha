import type {
  CacheStore,
  DraftReservation,
  LatestStateCache,
  TimedCacheValue,
  WorkspaceCache,
} from './store';
import type {
  CachedDialog,
  CachedMessage,
  PendingSend,
  SyncCursor,
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
  pending?: readonly PendingSend[] | undefined;
  lastPeerId?: string | undefined;
  pinned?: SeededMap<TimedCacheValue<TelegramMessage[]>> | undefined;
  pinnedMessages?: SeededMap<TimedCacheValue<TelegramMessage[]>> | undefined;
  groupMembers?: SeededMap<TimedCacheValue<TelegramGroupMember[]>> | undefined;
  blobs?: SeededMap<Blob> | undefined;
}

/**
 * An isolated CacheStore for tests.
 *
 * The store clones values at its boundary, just as IndexedDB does. Callers can
 * mutate fixtures and loaded values without changing the store's cached state.
 */
export class MemoryCacheStore implements CacheStore {
  private transportSession: unknown;
  private accountId: string | undefined;
  private cursor: SyncCursor | undefined;
  private epoch: number;
  private dialogs: CachedDialog[];
  private messages: CachedMessage[];
  private drafts: Map<string, string>;
  private draftRevisions: Map<string, number>;
  private pending: PendingSend[];
  private lastPeerId: string | undefined;
  private readonly pinnedMessages: Map<string, TimedCacheValue<TelegramMessage[]>>;
  private readonly groupMembers: Map<string, TimedCacheValue<TelegramGroupMember[]>>;
  private readonly blobs: Map<string, Blob>;
  constructor(initialState: MemoryCacheStoreInitialState = {}) {
    this.transportSession = clone(initialState.transportSession);
    this.accountId = initialState.accountId;
    this.cursor = clone(initialState.cursor);
    this.epoch = initialState.epoch ?? 0;
    this.dialogs = [...clone(initialState.dialogs ?? [])];
    this.messages = [...clone(initialState.messages ?? [])];
    this.drafts = new Map(Object.entries(clone(initialState.drafts ?? {})));
    this.draftRevisions = new Map(Object.entries(clone(initialState.draftRevisions ?? {})));
    this.pending = [...clone(initialState.pending ?? [])];
    this.lastPeerId = initialState.lastPeerId;
    this.pinnedMessages = seedMap(initialState.pinnedMessages ?? initialState.pinned);
    this.groupMembers = seedMap(initialState.groupMembers);
    this.blobs = seedMap(initialState.blobs);
  }

  async loadTransportSession() {
    return clone(this.transportSession);
  }

  async saveTransportSession(session: unknown) {
    this.transportSession = clone(session);
  }

  async clearAccountData() {
    this.transportSession = undefined;
    this.accountId = undefined;
    this.cursor = undefined;
    this.epoch = 0;
    this.dialogs = [];
    this.messages = [];
    this.drafts.clear();
    this.draftRevisions.clear();
    this.pending = [];
    this.lastPeerId = undefined;
    this.pinnedMessages.clear();
    this.groupMembers.clear();
    this.blobs.clear();
  }

  async clearCacheData() {
    this.cursor = undefined;
    this.epoch = 0;
    this.dialogs = [];
    this.messages = [];
    this.lastPeerId = undefined;
    this.pinnedMessages.clear();
    this.groupMembers.clear();
    this.blobs.clear();
  }

  async prepareOutboxWrite(_bytes: number, _forceEviction = false) {
    // Memory-backed writes have no storage quota to reserve.
  }

  async loadAccountId() {
    return this.accountId;
  }

  async claimAccount(accountId: string) {
    this.accountId = accountId;
    this.pending = this.pending.map((send) =>
      send.accountId === undefined ? { ...send, accountId } : send,
    );
  }

  async resetForAccount(accountId: string) {
    const previousAccountId = this.accountId;
    this.accountId = accountId;
    this.cursor = undefined;
    this.epoch = 0;
    this.dialogs = [];
    this.messages = [];
    this.drafts.clear();
    this.draftRevisions.clear();
    this.lastPeerId = undefined;
    this.pinnedMessages.clear();
    this.groupMembers.clear();
    this.blobs.clear();
    this.pending = this.pending.map((send) =>
      send.accountId === undefined
        ? {
            ...send,
            accountId: previousAccountId ?? LEGACY_ACCOUNT_ID,
            lastError: 'Queued for a different Telegram account.',
          }
        : send,
    );
  }

  async loadCursor() {
    return clone(this.cursor);
  }

  async saveCursor(cursor: SyncCursor) {
    this.cursor = clone(cursor);
  }

  async loadEpoch() {
    return this.epoch;
  }

  async beginNewEpoch() {
    this.epoch += 1;
    return this.epoch;
  }

  async commitLatestState(state: LatestStateCache) {
    const snapshot = clone(state);
    const epoch = this.epoch + 1;
    const dialogs = snapshot.dialogs.map((dialog) => ({ ...dialog, cacheEpoch: epoch }));
    const messages =
      snapshot.activeHistory?.messages.map((message) => ({ ...message, cacheEpoch: epoch })) ?? [];

    this.epoch = epoch;
    this.cursor = snapshot.cursor;
    this.dialogs = dialogs;
    this.messages = messages;
    for (const key of snapshot.discardBlobKeys ?? []) this.blobs.delete(key);
    return epoch;
  }

  async loadWorkspace(): Promise<WorkspaceCache> {
    return {
      accountId: this.accountId,
      dialogs: clone(this.dialogs),
      drafts: Object.fromEntries(this.drafts),
      draftRevisions: Object.fromEntries(this.draftRevisions),
      pending: this.sortedPending(),
      epoch: this.epoch,
      lastPeerId: this.lastPeerId,
    };
  }

  async loadDialogs() {
    return clone(this.dialogs);
  }

  async replaceDialogs(dialogs: CachedDialog[]) {
    this.dialogs = clone(dialogs);
  }

  async putDialog(dialog: CachedDialog) {
    const next = clone(dialog);
    this.dialogs = [...this.dialogs.filter(({ peer }) => peer.id !== next.peer.id), next];
  }

  async loadMessages(peerId: string, limit = DEFAULT_MESSAGE_LOAD_LIMIT) {
    const requested = normalizeLimit(limit);
    if (requested === 0) return [];
    const messages = this.messages
      .filter((message) => message.peerId === peerId)
      .sort((left, right) => left.id - right.id)
      .slice(-requested);
    return clone(messages);
  }

  async loadMessagesBefore(
    peerId: string,
    beforeMessageId: number,
    limit = DEFAULT_MESSAGE_LOAD_LIMIT,
  ) {
    const requested = normalizeLimit(limit);
    if (requested === 0) return [];
    const messages = this.messages
      .filter((message) => message.peerId === peerId && message.id < beforeMessageId)
      .sort((left, right) => left.id - right.id)
      .slice(-requested);
    return clone(messages);
  }

  async loadMessage(peerId: string, messageId: number) {
    const message = this.messages.find(
      (candidate) => candidate.peerId === peerId && candidate.id === messageId,
    );
    return clone(message);
  }

  async replaceMessages(peerId: string, messages: CachedMessage[]) {
    const replacements = clone(messages);
    this.messages = [
      ...this.messages.filter((message) => message.peerId !== peerId),
      ...replacements,
    ];
  }

  async putMessages(messages: CachedMessage[]) {
    const replacements = clone(messages);
    let nextMessages = this.messages;
    for (const replacement of replacements) {
      const replacementKey = messageKey(replacement.peerId, replacement.id);
      nextMessages = [
        ...nextMessages.filter(
          (message) => messageKey(message.peerId, message.id) !== replacementKey,
        ),
        replacement,
      ];
    }
    this.messages = nextMessages;
  }

  async putMessage(message: CachedMessage) {
    await this.putMessages([message]);
  }

  async deleteMessages(peerId: string | undefined, messageIds: number[]) {
    const ids = new Set(messageIds);
    this.messages = this.messages.filter(
      (message) => (peerId !== undefined && message.peerId !== peerId) || !ids.has(message.id),
    );
  }

  async loadPinnedMessages(peerId: string) {
    return clone(this.pinnedMessages.get(peerId));
  }

  async savePinnedMessages(peerId: string, messages: TelegramMessage[]) {
    this.pinnedMessages.set(peerId, { value: clone(messages), savedAt: Date.now() });
  }

  async deletePinnedMessages(peerId: string) {
    this.pinnedMessages.delete(peerId);
  }

  async loadGroupMembers(peerId: string) {
    return clone(this.groupMembers.get(peerId));
  }

  async saveGroupMembers(peerId: string, members: TelegramGroupMember[]) {
    this.groupMembers.set(peerId, { value: clone(members), savedAt: Date.now() });
  }

  async deleteGroupMembers(peerId: string) {
    this.groupMembers.delete(peerId);
  }

  async loadDrafts() {
    return Object.fromEntries(this.drafts);
  }

  async loadDraftRevisions() {
    return Object.fromEntries(this.draftRevisions);
  }

  async saveDraft(peerId: string, text: string, revision = 0) {
    if (text) {
      this.drafts.set(peerId, text);
      this.draftRevisions.set(peerId, revision);
      return;
    }
    this.drafts.delete(peerId);
    this.draftRevisions.delete(peerId);
  }

  async loadOutbox() {
    return this.sortedPending();
  }

  async commitOutbox(sends: PendingSend | PendingSend[], draft?: DraftReservation) {
    const batch = clone(Array.isArray(sends) ? sends : [sends]);
    if (batch.length === 0) return;

    const ids = new Set(batch.map(({ id }) => id));
    this.pending = [...this.pending.filter(({ id }) => !ids.has(id)), ...batch];
    if (
      draft &&
      this.drafts.get(draft.peerId) === draft.text &&
      (this.draftRevisions.get(draft.peerId) ?? 0) === (draft.revision ?? 0)
    ) {
      this.drafts.delete(draft.peerId);
      this.draftRevisions.delete(draft.peerId);
    }
  }

  async deletePending(id: string) {
    this.pending = this.pending.filter((send) => send.id !== id);
  }

  async loadBlob(key: string) {
    return clone(this.blobs.get(key));
  }

  async saveBlob(key: string, blob: Blob) {
    this.blobs.set(key, clone(blob));
  }

  async deleteBlob(key: string) {
    this.blobs.delete(key);
  }

  async loadLastPeerId() {
    return this.lastPeerId;
  }

  async saveLastPeerId(peerId: string) {
    this.lastPeerId = peerId;
  }

  private sortedPending() {
    return clone(this.pending).sort((left, right) => {
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
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function seedMap<T>(values?: SeededMap<T>): Map<string, T> {
  if (!values) return new Map();
  const entries = values instanceof Map ? [...values.entries()] : Object.entries(values);
  return new Map(clone(entries));
}

function normalizeLimit(limit: number) {
  if (!Number.isFinite(limit)) return limit > 0 ? Number.MAX_SAFE_INTEGER : 0;
  return Math.max(0, Math.floor(limit));
}

function messageKey(peerId: string, messageId: number) {
  return `${peerId.length}:${peerId}:${messageId}`;
}
