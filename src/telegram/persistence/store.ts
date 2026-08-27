import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

import type {
  CachedDialog,
  CachedMessage,
  PendingSend,
  SyncCursor,
  TelegramDialog,
  TelegramMessage,
} from '../types';

const MAX_CACHED_BLOBS = 256;
const MAX_CACHED_BLOB_BYTES = 256 * 1024 * 1024;
const MAX_CACHED_MESSAGES_PER_PEER = 1_000;
const MAX_CACHED_MESSAGES = 5_000;
const QUOTA_BLOB_EVICTION_COUNT = 32;
const QUOTA_MESSAGE_EVICTION_COUNT = 500;
const LEGACY_ACCOUNT_ID = 'legacy-unowned';
const DEFAULT_MESSAGE_LOAD_LIMIT = 500;

export interface LatestStateCache {
  cursor: SyncCursor;
  dialogs: TelegramDialog[];
  activeHistory?:
    | {
        peerId: string;
        messages: TelegramMessage[];
      }
    | undefined;
  discardBlobKeys?: string[] | undefined;
}

export interface DraftReservation {
  peerId: string;
  text: string;
  revision?: number | undefined;
}

export interface WorkspaceCache {
  accountId?: string | undefined;
  dialogs: CachedDialog[];
  draftRevisions: Record<string, number>;
  drafts: Record<string, string>;
  epoch: number;
  lastPeerId?: string | undefined;
  pending: PendingSend[];
}

interface TeleVechaSchema extends DBSchema {
  meta: {
    key: string;
    value: unknown;
  };
  dialogs: {
    key: string;
    value: CachedDialog;
  };
  messages: {
    key: [string, number];
    value: CachedMessage;
    indexes: { byPeer: string; byMessageId: number; byDate: number };
  };
  drafts: {
    key: string;
    value: { peerId: string; text: string; updatedAt: number; revision?: number };
  };
  outbox: {
    key: string;
    value: PendingSend;
    indexes: { byCreatedAt: number };
  };
  files: {
    key: string;
    value: { key: string; blob: Blob; savedAt: number };
  };
}

export interface CacheStore {
  loadTransportSession(): Promise<unknown>;
  saveTransportSession(session: unknown): Promise<void>;
  clearAccountData(): Promise<void>;
  clearCacheData(): Promise<void>;
  prepareOutboxWrite(bytes: number, forceEviction?: boolean): Promise<void>;
  loadAccountId(): Promise<string | undefined>;
  claimAccount(accountId: string): Promise<void>;
  resetForAccount(accountId: string): Promise<void>;
  loadCursor(): Promise<SyncCursor | undefined>;
  saveCursor(cursor: SyncCursor): Promise<void>;
  beginNewEpoch(): Promise<number>;
  commitLatestState(state: LatestStateCache): Promise<number>;
  loadWorkspace(): Promise<WorkspaceCache>;
  replaceDialogs(dialogs: CachedDialog[]): Promise<void>;
  putDialog(dialog: CachedDialog): Promise<void>;
  loadMessages(peerId: string, limit?: number): Promise<CachedMessage[]>;
  loadMessage(peerId: string, messageId: number): Promise<CachedMessage | undefined>;
  replaceMessages(peerId: string, messages: CachedMessage[]): Promise<void>;
  putMessages(messages: CachedMessage[]): Promise<void>;
  putMessage(message: CachedMessage): Promise<void>;
  deleteMessages(peerId: string | undefined, messageIds: number[]): Promise<void>;
  saveDraft(peerId: string, text: string, revision?: number): Promise<void>;
  commitOutbox(sends: PendingSend | PendingSend[], draft?: DraftReservation): Promise<void>;
  deletePending(id: string): Promise<void>;
  loadBlob(key: string): Promise<Blob | undefined>;
  saveBlob(key: string, blob: Blob): Promise<void>;
  deleteBlob(key: string): Promise<void>;
  saveLastPeerId(peerId: string): Promise<void>;
}

export class IndexedDbCacheStore implements CacheStore {
  private readonly database: Promise<IDBPDatabase<TeleVechaSchema>>;

  constructor(name = 'televecha') {
    this.database = openDB<TeleVechaSchema>(name, 6, {
      upgrade(database, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          database.createObjectStore('meta');
          database.createObjectStore('dialogs', { keyPath: 'peer.id' });
          const messages = database.createObjectStore('messages', {
            keyPath: ['peerId', 'id'],
          });
          messages.createIndex('byPeer', 'peerId');
          messages.createIndex('byMessageId', 'id');
          messages.createIndex('byDate', 'date');
          database.createObjectStore('drafts', { keyPath: 'peerId' });
          const outbox = database.createObjectStore('outbox', { keyPath: 'id' });
          outbox.createIndex('byCreatedAt', 'createdAt');
        }
        // Version 2 stored raw Blob values under out-of-line keys. Files are a
        // disposable cache, so recreate only this store when moving to records
        // with timestamps instead of attempting an unsafe in-place migration.
        if (oldVersion < 3) {
          if (database.objectStoreNames.contains('files')) database.deleteObjectStore('files');
          database.createObjectStore('files', { keyPath: 'key' });
        }
        if (oldVersion < 4) {
          const messages = transaction.objectStore('messages');
          if (!messages.indexNames.contains('byMessageId')) {
            messages.createIndex('byMessageId', 'id');
          }
          if (!messages.indexNames.contains('byDate')) messages.createIndex('byDate', 'date');
        }
        if (oldVersion === 4) {
          void transaction.objectStore('dialogs').clear();
          void transaction.objectStore('messages').clear();
          void transaction.objectStore('files').clear();
          const meta = transaction.objectStore('meta');
          void meta.delete('cursor');
          void meta.delete('epoch');
          void meta.delete('last-peer-id');
        }
      },
    });
  }

  async loadTransportSession() {
    return (await this.database).get('meta', 'transport-session');
  }

  async saveTransportSession(session: unknown) {
    const database = await this.database;
    if (session === undefined) {
      await database.delete('meta', 'transport-session');
    } else {
      await database.put('meta', session, 'transport-session');
    }
  }

  async clearAccountData() {
    const database = await this.database;
    const transaction = database.transaction(
      ['meta', 'dialogs', 'messages', 'drafts', 'outbox', 'files'],
      'readwrite',
    );
    await Promise.all([
      transaction.objectStore('meta').clear(),
      transaction.objectStore('dialogs').clear(),
      transaction.objectStore('messages').clear(),
      transaction.objectStore('drafts').clear(),
      transaction.objectStore('outbox').clear(),
      transaction.objectStore('files').clear(),
    ]);
    await transaction.done;
  }

  async clearCacheData() {
    const database = await this.database;
    const transaction = database.transaction(['meta', 'dialogs', 'messages', 'files'], 'readwrite');
    const meta = transaction.objectStore('meta');
    await Promise.all([
      transaction.objectStore('dialogs').clear(),
      transaction.objectStore('messages').clear(),
      transaction.objectStore('files').clear(),
      meta.delete('cursor'),
      meta.delete('epoch'),
      meta.delete('last-peer-id'),
    ]);
    await transaction.done;
  }

  async prepareOutboxWrite(bytes: number, forceEviction = false) {
    if (bytes <= 0 || typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
    await navigator.storage.persist?.().catch(() => false);
    const hasRoom = async () => {
      const { quota, usage } = await navigator.storage.estimate();
      if (quota === undefined || usage === undefined) return true;
      const reserve = Math.max(16 * 1024 * 1024, Math.ceil(bytes * 0.05));
      return quota - usage >= bytes + reserve;
    };
    if (!forceEviction && (await hasRoom())) return;
    await Promise.all([
      this.evictOldestBlobs(MAX_CACHED_BLOBS),
      this.evictOldestMessages(MAX_CACHED_MESSAGES),
    ]);
    if (await hasRoom()) return;
    throw new DOMException(
      `This browser does not have enough storage for the ${this.formatBytes(bytes)} durable send queue entry.`,
      'QuotaExceededError',
    );
  }

  async loadAccountId() {
    return (await this.database).get('meta', 'account-id') as Promise<string | undefined>;
  }

  async claimAccount(accountId: string) {
    const database = await this.database;
    const transaction = database.transaction(['meta', 'outbox'], 'readwrite');
    const outbox = transaction.objectStore('outbox');
    const pending = await outbox.getAll();
    await Promise.all([
      transaction.objectStore('meta').put(accountId, 'account-id'),
      ...pending
        .filter((send) => !send.accountId)
        .map((send) => outbox.put({ ...send, accountId })),
    ]);
    await transaction.done;
  }

  async resetForAccount(accountId: string) {
    const database = await this.database;
    const transaction = database.transaction(
      ['meta', 'dialogs', 'messages', 'drafts', 'outbox', 'files'],
      'readwrite',
    );
    const meta = transaction.objectStore('meta');
    const outbox = transaction.objectStore('outbox');
    const previousAccountId = (await meta.get('account-id')) as string | undefined;
    const pending = await outbox.getAll();
    await Promise.all([
      transaction.objectStore('dialogs').clear(),
      transaction.objectStore('messages').clear(),
      transaction.objectStore('drafts').clear(),
      transaction.objectStore('files').clear(),
      meta.delete('cursor'),
      meta.delete('epoch'),
      meta.delete('last-peer-id'),
      ...pending
        .filter((send) => !send.accountId)
        .map((send) =>
          outbox.put({
            ...send,
            accountId: previousAccountId ?? LEGACY_ACCOUNT_ID,
            lastError: 'Queued for a different Telegram account.',
          }),
        ),
      meta.put(accountId, 'account-id'),
    ]);
    await transaction.done;
  }

  async loadCursor() {
    return (await this.database).get('meta', 'cursor') as Promise<SyncCursor | undefined>;
  }

  async saveCursor(cursor: SyncCursor) {
    await (await this.database).put('meta', cursor, 'cursor');
  }

  async loadEpoch() {
    return ((await (await this.database).get('meta', 'epoch')) as number | undefined) ?? 0;
  }

  async loadWorkspace(): Promise<WorkspaceCache> {
    const [accountId, dialogs, drafts, draftRevisions, pending, epoch, lastPeerId] =
      await Promise.all([
        this.loadAccountId(),
        this.loadDialogs(),
        this.loadDrafts(),
        this.loadDraftRevisions(),
        this.loadOutbox(),
        this.loadEpoch(),
        this.loadLastPeerId(),
      ]);
    return { accountId, dialogs, drafts, draftRevisions, pending, epoch, lastPeerId };
  }

  async beginNewEpoch() {
    const database = await this.database;
    const transaction = database.transaction('meta', 'readwrite');
    const current = ((await transaction.store.get('epoch')) as number | undefined) ?? 0;
    const next = current + 1;
    await transaction.store.put(next, 'epoch');
    await transaction.done;
    return next;
  }

  async commitLatestState(state: LatestStateCache) {
    const database = await this.database;
    const transaction = database.transaction(['meta', 'dialogs', 'messages', 'files'], 'readwrite');
    const operations: Promise<unknown>[] = [];
    try {
      const meta = transaction.objectStore('meta');
      const dialogs = transaction.objectStore('dialogs');
      const messages = transaction.objectStore('messages');
      const files = transaction.objectStore('files');
      const current = ((await meta.get('epoch')) as number | undefined) ?? 0;
      const epoch = current + 1;
      const cachedDialogs = state.dialogs.map((dialog) => ({ ...dialog, cacheEpoch: epoch }));
      const cachedMessages =
        state.activeHistory?.messages.map((message) => ({ ...message, cacheEpoch: epoch })) ?? [];

      operations.push(dialogs.clear(), messages.clear());
      operations.push(meta.put(epoch, 'epoch'), meta.put(state.cursor, 'cursor'));
      for (const dialog of cachedDialogs) operations.push(dialogs.put(dialog));
      for (const message of cachedMessages) operations.push(messages.put(message));
      for (const key of state.discardBlobKeys ?? []) operations.push(files.delete(key));
      await Promise.all(operations);
      await transaction.done;
      return epoch;
    } catch (error) {
      const settledOperations = Promise.allSettled(operations);
      const settledTransaction = transaction.done.catch(() => undefined);
      try {
        transaction.abort();
      } catch {
        // A rejected IndexedDB request may already have aborted the transaction.
      }
      await Promise.all([settledOperations, settledTransaction]);
      throw error;
    }
  }

  async loadDialogs() {
    return (await this.database).getAll('dialogs');
  }

  async replaceDialogs(dialogs: CachedDialog[]) {
    const transaction = (await this.database).transaction('dialogs', 'readwrite');
    await transaction.store.clear();
    await Promise.all(dialogs.map((dialog) => transaction.store.put(dialog)));
    await transaction.done;
  }

  async putDialog(dialog: CachedDialog) {
    await (await this.database).put('dialogs', dialog);
  }

  async loadMessages(peerId: string, limit = DEFAULT_MESSAGE_LOAD_LIMIT) {
    const requested = Math.max(0, limit);
    if (requested === 0) return [];
    const transaction = (await this.database).transaction('messages');
    const messages: CachedMessage[] = [];
    let cursor = await transaction.store
      .index('byPeer')
      .openCursor(IDBKeyRange.only(peerId), 'prev');
    while (cursor && messages.length < requested) {
      messages.push(cursor.value);
      cursor = await cursor.continue();
    }
    await transaction.done;
    return messages.reverse();
  }

  async loadMessage(peerId: string, messageId: number) {
    return (await this.database).get('messages', [peerId, messageId]);
  }

  async replaceMessages(peerId: string, messages: CachedMessage[]) {
    try {
      await this.writeReplacementMessages(peerId, messages);
    } catch (error) {
      if (!this.isQuotaError(error)) throw error;
      await this.evictForMessageQuota();
      await this.writeReplacementMessages(peerId, messages);
    }
    await this.pruneMessageCache([peerId]);
  }

  async putMessages(messages: CachedMessage[]) {
    if (messages.length === 0) return;
    try {
      await this.writeMessages(messages);
    } catch (error) {
      if (!this.isQuotaError(error)) throw error;
      await this.evictForMessageQuota();
      await this.writeMessages(messages);
    }
    await this.pruneMessageCache([...new Set(messages.map(({ peerId }) => peerId))]);
  }

  async putMessage(message: CachedMessage) {
    await this.putMessages([message]);
  }

  async deleteMessages(peerId: string | undefined, messageIds: number[]) {
    const transaction = (await this.database).transaction('messages', 'readwrite');
    if (peerId) {
      await Promise.all(messageIds.map((id) => transaction.store.delete([peerId, id])));
    } else {
      const index = transaction.store.index('byMessageId');
      for (const id of new Set(messageIds)) {
        const keys = await index.getAllKeys(IDBKeyRange.only(id));
        await Promise.all(keys.map((key) => transaction.store.delete(key)));
      }
    }
    await transaction.done;
  }

  async loadDrafts() {
    const drafts = await (await this.database).getAll('drafts');
    return Object.fromEntries(drafts.map(({ peerId, text }) => [peerId, text]));
  }

  async loadDraftRevisions() {
    const drafts = await (await this.database).getAll('drafts');
    return Object.fromEntries(drafts.map(({ peerId, revision }) => [peerId, revision ?? 0]));
  }

  async saveDraft(peerId: string, text: string, revision = 0) {
    const database = await this.database;
    if (!text) {
      await database.delete('drafts', peerId);
      return;
    }
    await database.put('drafts', { peerId, text, updatedAt: Date.now(), revision });
  }

  async loadOutbox() {
    const sends = await (await this.database).getAllFromIndex('outbox', 'byCreatedAt');
    return sends.sort((left, right) => {
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

  async commitOutbox(sends: PendingSend | PendingSend[], draft?: DraftReservation) {
    const pending = Array.isArray(sends) ? sends : [sends];
    if (pending.length === 0) return;
    const transaction = (await this.database).transaction(['outbox', 'drafts'], 'readwrite');
    const writes: Array<Promise<string>> = [];
    try {
      const outbox = transaction.objectStore('outbox');
      const drafts = transaction.objectStore('drafts');
      const current = draft ? await drafts.get(draft.peerId) : undefined;
      for (const send of pending) writes.push(outbox.put(send));
      await Promise.all(writes);
      if (
        draft &&
        current?.text === draft.text &&
        (current.revision ?? 0) === (draft.revision ?? 0)
      ) {
        await drafts.delete(draft.peerId);
      }
      await transaction.done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The failed request may already have aborted the transaction.
      }
      await Promise.allSettled(writes);
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  async deletePending(id: string) {
    await (await this.database).delete('outbox', id);
  }

  async loadBlob(key: string) {
    return (await (await this.database).get('files', key))?.blob;
  }

  async saveBlob(key: string, blob: Blob) {
    const database = await this.database;
    const record = { key, blob, savedAt: Date.now() };
    try {
      await database.put('files', record);
    } catch (error) {
      if (!this.isQuotaError(error)) throw error;
      await this.evictOldestBlobs(QUOTA_BLOB_EVICTION_COUNT);
      await database.put('files', record);
    }
    await this.pruneBlobCache();
  }

  async deleteBlob(key: string) {
    await (await this.database).delete('files', key);
  }

  async loadLastPeerId() {
    return (await this.database).get('meta', 'last-peer-id') as Promise<string | undefined>;
  }

  async saveLastPeerId(peerId: string) {
    await (await this.database).put('meta', peerId, 'last-peer-id');
  }

  private isQuotaError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'QuotaExceededError'
    );
  }

  private async writeReplacementMessages(peerId: string, messages: CachedMessage[]) {
    const transaction = (await this.database).transaction('messages', 'readwrite');
    try {
      const keys = await transaction.store.index('byPeer').getAllKeys(peerId);
      await Promise.all(keys.map((key) => transaction.store.delete(key)));
      for (const message of messages) await transaction.store.put(message);
      await transaction.done;
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  private async writeMessages(messages: CachedMessage[]) {
    const transaction = (await this.database).transaction('messages', 'readwrite');
    try {
      for (const message of messages) await transaction.store.put(message);
      await transaction.done;
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  private async pruneMessageCache(peerIds: string[]) {
    const transaction = (await this.database).transaction('messages', 'readwrite');
    for (const peerId of peerIds) {
      const index = transaction.store.index('byPeer');
      let excess = (await index.count(IDBKeyRange.only(peerId))) - MAX_CACHED_MESSAGES_PER_PEER;
      if (excess <= 0) continue;
      let cursor = await index.openCursor(IDBKeyRange.only(peerId));
      while (cursor && excess > 0) {
        await cursor.delete();
        excess -= 1;
        cursor = await cursor.continue();
      }
    }

    let excess = (await transaction.store.count()) - MAX_CACHED_MESSAGES;
    if (excess > 0) {
      let cursor = await transaction.store.index('byDate').openCursor();
      while (cursor && excess > 0) {
        await cursor.delete();
        excess -= 1;
        cursor = await cursor.continue();
      }
    }
    await transaction.done;
  }

  private async evictForMessageQuota() {
    await Promise.all([
      this.evictOldestMessages(QUOTA_MESSAGE_EVICTION_COUNT),
      this.evictOldestBlobs(QUOTA_BLOB_EVICTION_COUNT),
    ]);
  }

  private async evictOldestMessages(count: number) {
    const transaction = (await this.database).transaction('messages', 'readwrite');
    let remaining = count;
    let cursor = await transaction.store.index('byDate').openCursor();
    while (cursor && remaining > 0) {
      await cursor.delete();
      remaining -= 1;
      cursor = await cursor.continue();
    }
    await transaction.done;
  }

  private async evictOldestBlobs(count: number) {
    const transaction = (await this.database).transaction('files', 'readwrite');
    const records = await transaction.store.getAll();
    records.sort((left, right) => left.savedAt - right.savedAt);
    await Promise.all(records.slice(0, count).map(({ key }) => transaction.store.delete(key)));
    await transaction.done;
  }

  private async pruneBlobCache() {
    const transaction = (await this.database).transaction('files', 'readwrite');
    const records = await transaction.store.getAll();
    records.sort((left, right) => right.savedAt - left.savedAt);
    let retainedBytes = 0;
    const removals: string[] = [];
    for (const [index, record] of records.entries()) {
      const nextBytes = retainedBytes + record.blob.size;
      if (index >= MAX_CACHED_BLOBS || nextBytes > MAX_CACHED_BLOB_BYTES) {
        removals.push(record.key);
      } else {
        retainedBytes = nextBytes;
      }
    }
    await Promise.all(removals.map((key) => transaction.store.delete(key)));
    await transaction.done;
  }

  private formatBytes(bytes: number) {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${Math.ceil(bytes / (1024 * 1024))} MB`;
    return `${Math.ceil(bytes / 1024)} KB`;
  }
}
