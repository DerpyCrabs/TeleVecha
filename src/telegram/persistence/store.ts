import { Effect, Exit, Schema } from 'effect';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

import type {
  CachedDialog,
  CachedMessage,
  PendingSend,
  SyncCursor,
  TelegramDialog,
  TelegramDraftDetails,
  TelegramGroupMember,
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
const ATOMIC_WRITE_TIMEOUT_MS = 10_000;
const PINNED_MESSAGES_KEY_PREFIX = 'pinned-messages:';
const GROUP_MEMBERS_KEY_PREFIX = 'group-members:';
const RESOURCE_METADATA_KEY_PREFIX = 'resource-metadata:';

export class CacheStoreError extends Schema.TaggedError<CacheStoreError>()('CacheStoreError', {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const cacheStoreError = (operation: string, cause: unknown): CacheStoreError =>
  new CacheStoreError({
    operation,
    message: `Local storage failed while ${operation}.`,
    ...(cause === undefined ? {} : { cause }),
  });

interface AtomicWriteTransaction {
  abort(): void;
  readonly done: Promise<void>;
}

interface AtomicWriteContext<Transaction> {
  readonly transaction: Transaction;
  readonly request: <Value>(request: Promise<Value>) => Effect.Effect<Value, CacheStoreError>;
}

const runAtomicWrite = <Transaction extends AtomicWriteTransaction, Value>(
  acquire: () => Transaction,
  use: (context: AtomicWriteContext<Transaction>) => Effect.Effect<Value, CacheStoreError>,
): Effect.Effect<Value, CacheStoreError> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const transaction = acquire();
        void transaction.done.catch(() => undefined);
        const request = <RequestValue>(pending: Promise<RequestValue>) => {
          void pending.catch(() => undefined);
          return idbRequest(() => pending);
        };
        return { transaction, request };
      },
      catch: (cause) => cacheStoreError('starting a transaction', cause),
    }),
    ({ transaction, request }) =>
      Effect.gen(function* () {
        const value = yield* use({ transaction, request });
        yield* idbRequest(() => transaction.done);
        return value;
      }).pipe(
        Effect.timeoutOrElse({
          duration: ATOMIC_WRITE_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              cacheStoreError('committing a transaction', new Error('Timed out after 10 seconds.')),
            ),
        }),
      ),
    ({ transaction }, exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.sync(() => {
            try {
              transaction.abort();
            } catch {
              // A rejected IndexedDB request may already have aborted the transaction.
            }
          }).pipe(Effect.andThen(idbRequest(() => transaction.done).pipe(Effect.ignore))),
  );
export interface TimedCacheValue<T> {
  value: T;
  savedAt: number;
}

export interface LatestStateCache {
  cursor: SyncCursor;
  dialogs: TelegramDialog[];
  discardBlobKeys?: string[] | undefined;
  discardMetadataKeys?: string[] | undefined;
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
  draftDetails: Record<string, TelegramDraftDetails>;
  epoch: number;
  pending: PendingSend[];
}

/**
 * A logical, account-free checkpoint for deterministic debugging. It excludes
 * the transport session and cached file bytes by construction.
 */
export interface CacheCheckpoint {
  cursor?: SyncCursor | undefined;
  dialogs: CachedDialog[];
  draftRevisions: Record<string, number>;
  drafts: Record<string, string>;
  draftDetails?: Record<string, TelegramDraftDetails>;
  epoch: number;
  groupMembers: Record<string, TimedCacheValue<TelegramGroupMember[]>>;
  lastPeerId?: string | undefined;
  messages: CachedMessage[];
  pending: PendingSend[];
  pinnedMessages: Record<string, TimedCacheValue<TelegramMessage[]>>;
}

interface TeleVechaSchema extends DBSchema {
  meta: { key: string; value: unknown };
  dialogs: { key: string; value: CachedDialog };
  messages: {
    key: [string, number];
    value: CachedMessage;
    indexes: { byPeer: string; byMessageId: number; byDate: number };
  };
  drafts: {
    key: string;
    value: {
      peerId: string;
      text: string;
      updatedAt: number;
      revision?: number;
      details?: TelegramDraftDetails;
    };
  };
  outbox: { key: string; value: PendingSend; indexes: { byCreatedAt: number } };
  files: { key: string; value: { key: string; blob: Blob; savedAt: number } };
}

export interface TransportSessionStorage {
  readonly loadTransportSession: Effect.Effect<unknown, CacheStoreError>;
  readonly saveTransportSession: (session: unknown) => Effect.Effect<void, CacheStoreError>;
}

export interface CacheStore {
  clearAccountData(): Effect.Effect<void, CacheStoreError>;
  clearCacheData(): Effect.Effect<void, CacheStoreError>;
  prepareOutboxWrite(bytes: number, forceEviction?: boolean): Effect.Effect<void, CacheStoreError>;
  loadAccountId(): Effect.Effect<string | undefined, CacheStoreError>;
  claimAccount(accountId: string): Effect.Effect<void, CacheStoreError>;
  resetForAccount(accountId: string): Effect.Effect<void, CacheStoreError>;
  loadCursor(): Effect.Effect<SyncCursor | undefined, CacheStoreError>;
  saveCursor(cursor: SyncCursor): Effect.Effect<void, CacheStoreError>;
  beginNewEpoch(): Effect.Effect<number, CacheStoreError>;
  commitLatestState(state: LatestStateCache): Effect.Effect<number, CacheStoreError>;
  loadWorkspace(): Effect.Effect<WorkspaceCache, CacheStoreError>;
  replaceDialogs(dialogs: CachedDialog[]): Effect.Effect<void, CacheStoreError>;
  putDialog(dialog: CachedDialog): Effect.Effect<void, CacheStoreError>;
  loadMessages(peerId: string, limit?: number): Effect.Effect<CachedMessage[], CacheStoreError>;
  loadMessagesBefore(
    peerId: string,
    beforeMessageId: number,
    limit?: number,
  ): Effect.Effect<CachedMessage[], CacheStoreError>;
  loadMessage(
    peerId: string,
    messageId: number,
  ): Effect.Effect<CachedMessage | undefined, CacheStoreError>;
  replaceMessages(peerId: string, messages: CachedMessage[]): Effect.Effect<void, CacheStoreError>;
  putMessages(messages: CachedMessage[]): Effect.Effect<void, CacheStoreError>;
  putMessage(message: CachedMessage): Effect.Effect<void, CacheStoreError>;
  findMessagePeers(messageIds: number[]): Effect.Effect<string[], CacheStoreError>;
  deleteMessages(peerId: string, messageIds: number[]): Effect.Effect<void, CacheStoreError>;
  loadPinnedMessages(
    peerId: string,
  ): Effect.Effect<TimedCacheValue<TelegramMessage[]> | undefined, CacheStoreError>;
  savePinnedMessages(
    peerId: string,
    messages: TelegramMessage[],
  ): Effect.Effect<void, CacheStoreError>;
  deletePinnedMessages(peerId: string): Effect.Effect<void, CacheStoreError>;
  loadGroupMembers(
    peerId: string,
  ): Effect.Effect<TimedCacheValue<TelegramGroupMember[]> | undefined, CacheStoreError>;
  saveGroupMembers(
    peerId: string,
    members: TelegramGroupMember[],
  ): Effect.Effect<void, CacheStoreError>;
  deleteGroupMembers(peerId: string): Effect.Effect<void, CacheStoreError>;
  loadMetadata<Value>(
    key: string,
  ): Effect.Effect<TimedCacheValue<Value> | undefined, CacheStoreError>;
  saveMetadata<Value>(key: string, value: Value): Effect.Effect<void, CacheStoreError>;
  deleteMetadata(key: string): Effect.Effect<void, CacheStoreError>;
  saveDraft(
    peerId: string,
    text: string,
    revision?: number,
    details?: TelegramDraftDetails,
  ): Effect.Effect<void, CacheStoreError>;
  commitOutbox(
    sends: PendingSend | PendingSend[],
    draft?: DraftReservation,
  ): Effect.Effect<void, CacheStoreError>;
  deletePending(id: string): Effect.Effect<void, CacheStoreError>;
  loadBlob(key: string): Effect.Effect<Blob | undefined, CacheStoreError>;
  saveBlob(key: string, blob: Blob): Effect.Effect<void, CacheStoreError>;
  deleteBlob(key: string): Effect.Effect<void, CacheStoreError>;
}

const openTeleVechaDatabase = (name: string) =>
  Effect.acquireRelease(
    Effect.callback<IDBPDatabase<TeleVechaSchema>, CacheStoreError>((resume) => {
      let settled = false;
      let databaseConnection: IDBPDatabase<TeleVechaSchema> | undefined;
      let opening: PromiseLike<IDBPDatabase<TeleVechaSchema>>;
      try {
        opening = openDB<TeleVechaSchema>(name, 6, {
          blocked() {
            if (settled) return;
            settled = true;
            resume(
              Effect.fail(
                cacheStoreError(
                  'opening the database',
                  new Error(
                    'TeleVecha storage is open in another tab. Close or reload the other tab, then try again.',
                  ),
                ),
              ),
            );
          },
          blocking() {
            databaseConnection?.close();
          },
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
      } catch (error) {
        settled = true;
        resume(Effect.fail(cacheStoreError('opening the database', error)));
        return Effect.void;
      }
      void opening.then(
        (database) => {
          databaseConnection = database;
          if (settled) database.close();
          else {
            settled = true;
            resume(Effect.succeed(database));
          }
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          resume(Effect.fail(cacheStoreError('opening the database', error)));
        },
      );
      return Effect.sync(() => {
        settled = true;
        databaseConnection?.close();
      });
    }),
    (database) => Effect.sync(() => database.close()),
  );

const idbRequest = <Value>(request: () => PromiseLike<Value>) =>
  Effect.tryPromise({
    try: request,
    catch: (error) => cacheStoreError('executing a request', error),
  });
function makeIndexedDbCacheStoreModule(database: IDBPDatabase<TeleVechaSchema>) {
  let databaseHandle = database;
  const captureCheckpoint = Effect.fn('IndexedDbCacheStore.captureCheckpoint')(function* () {
    const database = databaseHandle;
    const transaction = database.transaction(
      ['meta', 'dialogs', 'messages', 'drafts', 'outbox'],
      'readonly',
    );
    const meta = transaction.objectStore('meta');
    const drafts = transaction.objectStore('drafts');
    const pinnedRange = IDBKeyRange.bound(
      PINNED_MESSAGES_KEY_PREFIX,
      `${PINNED_MESSAGES_KEY_PREFIX}\uffff`,
    );
    const membersRange = IDBKeyRange.bound(
      GROUP_MEMBERS_KEY_PREFIX,
      `${GROUP_MEMBERS_KEY_PREFIX}\uffff`,
    );
    const [
      cursor,
      epoch,
      lastPeerId,
      dialogs,
      messages,
      draftRecords,
      pending,
      pinnedKeys,
      pinnedValues,
      memberKeys,
      memberValues,
    ] = yield* Effect.all([
      idbRequest(() => meta.get('cursor') as Promise<SyncCursor | undefined>),
      idbRequest(() => meta.get('epoch') as Promise<number | undefined>),
      idbRequest(() => meta.get('last-peer-id') as Promise<string | undefined>),
      idbRequest(() => transaction.objectStore('dialogs').getAll()),
      idbRequest(() => transaction.objectStore('messages').getAll()),
      idbRequest(() => drafts.getAll()),
      idbRequest(() => transaction.objectStore('outbox').getAll()),
      idbRequest(() => meta.getAllKeys(pinnedRange)),
      idbRequest(() => meta.getAll(pinnedRange) as Promise<TimedCacheValue<TelegramMessage[]>[]>),
      idbRequest(() => meta.getAllKeys(membersRange)),
      idbRequest(
        () => meta.getAll(membersRange) as Promise<TimedCacheValue<TelegramGroupMember[]>[]>,
      ),
    ]);
    const pinnedMessages: Record<string, TimedCacheValue<TelegramMessage[]>> = {};
    const groupMembers: Record<string, TimedCacheValue<TelegramGroupMember[]>> = {};
    pinnedKeys.forEach((key, index) => {
      const value = pinnedValues[index];
      if (value) pinnedMessages[key.slice(PINNED_MESSAGES_KEY_PREFIX.length)] = value;
    });
    memberKeys.forEach((key, index) => {
      const value = memberValues[index];
      if (value) groupMembers[key.slice(GROUP_MEMBERS_KEY_PREFIX.length)] = value;
    });
    yield* idbRequest(() => transaction.done);
    return {
      cursor,
      dialogs,
      draftRevisions: Object.fromEntries(
        draftRecords.map(({ peerId, revision }) => [peerId, revision ?? 0]),
      ),
      drafts: Object.fromEntries(draftRecords.map(({ peerId, text }) => [peerId, text])),
      draftDetails: Object.fromEntries(
        draftRecords.flatMap(({ peerId, details }) => (details ? [[peerId, details]] : [])),
      ),
      epoch: epoch ?? 0,
      groupMembers,
      lastPeerId,
      messages,
      pending: pending.sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      ),
      pinnedMessages,
    };
  });
  function loadTransportSessionInternal() {
    return idbRequest(() => databaseHandle.get('meta', 'transport-session'));
  }
  function saveTransportSession(session: unknown) {
    return idbRequest(() =>
      session === undefined
        ? databaseHandle.delete('meta', 'transport-session')
        : databaseHandle.put('meta', session, 'transport-session').then(() => undefined),
    );
  }
  const clearAccountData = Effect.fn('IndexedDbCacheStore.clearAccountData')(function* () {
    const database = databaseHandle;
    yield* runAtomicWrite(
      () =>
        database.transaction(
          ['meta', 'dialogs', 'messages', 'drafts', 'outbox', 'files'],
          'readwrite',
        ),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          yield* Effect.all([
            request(transaction.objectStore('meta').clear()),
            request(transaction.objectStore('dialogs').clear()),
            request(transaction.objectStore('messages').clear()),
            request(transaction.objectStore('drafts').clear()),
            request(transaction.objectStore('outbox').clear()),
            request(transaction.objectStore('files').clear()),
          ]);
        }),
    );
  });
  const clearCacheData = Effect.fn('IndexedDbCacheStore.clearCacheData')(function* () {
    const database = databaseHandle;
    yield* runAtomicWrite(
      () => database.transaction(['meta', 'dialogs', 'messages', 'files'], 'readwrite'),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          const meta = transaction.objectStore('meta');
          const metadataKeys = (yield* request(meta.getAllKeys())).filter(
            (key) =>
              key.startsWith(PINNED_MESSAGES_KEY_PREFIX) ||
              key.startsWith(GROUP_MEMBERS_KEY_PREFIX) ||
              key.startsWith(RESOURCE_METADATA_KEY_PREFIX),
          );
          yield* Effect.all([
            request(transaction.objectStore('dialogs').clear()),
            request(transaction.objectStore('messages').clear()),
            request(transaction.objectStore('files').clear()),
            request(meta.delete('cursor')),
            request(meta.delete('epoch')),
            request(meta.delete('last-peer-id')),
            ...metadataKeys.map((key) => request(meta.delete(key))),
          ]);
        }),
    );
  });
  const prepareOutboxWrite = Effect.fn('IndexedDbCacheStore.prepareOutboxWrite')(function* (
    bytes: number,
    forceEviction = false,
  ) {
    if (bytes <= 0 || typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
    yield* idbRequest(() => navigator.storage.persist?.().catch(() => false));
    const hasRoom = () =>
      Effect.gen(function* () {
        const { quota, usage } = yield* idbRequest(() => navigator.storage.estimate());
        if (quota === undefined || usage === undefined) return true;
        const reserve = Math.max(16 * 1024 * 1024, Math.ceil(bytes * 0.05));
        return quota - usage >= bytes + reserve;
      });
    if (!forceEviction && (yield* hasRoom())) return;
    yield* Effect.all([
      evictOldestBlobs(MAX_CACHED_BLOBS),
      evictOldestMessages(MAX_CACHED_MESSAGES),
    ]);
    if (yield* hasRoom()) return;
    return yield* Effect.fail(
      cacheStoreError(
        'reserving durable outbox storage',
        new DOMException(
          `This browser does not have enough storage for the ${formatBytes(bytes)} durable send queue entry.`,
          'QuotaExceededError',
        ),
      ),
    );
  });
  const loadAccountId = Effect.fn('IndexedDbCacheStore.loadAccountId')(function* () {
    return yield* idbRequest(
      () => databaseHandle.get('meta', 'account-id') as Promise<string | undefined>,
    );
  });
  const claimAccount = Effect.fn('IndexedDbCacheStore.claimAccount')(function* (accountId: string) {
    const database = databaseHandle;
    yield* runAtomicWrite(
      () => database.transaction(['meta', 'outbox'], 'readwrite'),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          const outbox = transaction.objectStore('outbox');
          const pending = yield* request(outbox.getAll());
          yield* Effect.all([
            request(transaction.objectStore('meta').put(accountId, 'account-id')),
            ...pending
              .filter((send) => !send.accountId)
              .map((send) => request(outbox.put({ ...send, accountId }))),
          ]);
        }),
    );
  });
  const resetForAccount = Effect.fn('IndexedDbCacheStore.resetForAccount')(function* (
    accountId: string,
  ) {
    const database = databaseHandle;
    yield* runAtomicWrite(
      () =>
        database.transaction(
          ['meta', 'dialogs', 'messages', 'drafts', 'outbox', 'files'],
          'readwrite',
        ),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          const meta = transaction.objectStore('meta');
          const outbox = transaction.objectStore('outbox');
          const previousAccountId = (yield* request(meta.get('account-id'))) as string | undefined;
          const metadataKeys = (yield* request(meta.getAllKeys())).filter(
            (key) =>
              key.startsWith(PINNED_MESSAGES_KEY_PREFIX) ||
              key.startsWith(GROUP_MEMBERS_KEY_PREFIX) ||
              key.startsWith(RESOURCE_METADATA_KEY_PREFIX),
          );
          const pending = yield* request(outbox.getAll());
          yield* Effect.all([
            request(transaction.objectStore('dialogs').clear()),
            request(transaction.objectStore('messages').clear()),
            request(transaction.objectStore('drafts').clear()),
            request(transaction.objectStore('files').clear()),
            request(meta.delete('cursor')),
            request(meta.delete('epoch')),
            request(meta.delete('last-peer-id')),
            ...metadataKeys.map((key) => request(meta.delete(key))),
            ...pending
              .filter((send) => !send.accountId)
              .map((send) =>
                request(
                  outbox.put({
                    ...send,
                    accountId: previousAccountId ?? LEGACY_ACCOUNT_ID,
                    lastError: 'Queued for a different Telegram account.',
                  }),
                ),
              ),
            request(meta.put(accountId, 'account-id')),
          ]);
        }),
    );
  });
  const loadCursor = Effect.fn('IndexedDbCacheStore.loadCursor')(function* () {
    return yield* idbRequest(
      () => databaseHandle.get('meta', 'cursor') as Promise<SyncCursor | undefined>,
    );
  });
  const saveCursor = Effect.fn('IndexedDbCacheStore.saveCursor')(function* (cursor: SyncCursor) {
    yield* idbRequest(() => databaseHandle.put('meta', cursor, 'cursor'));
  });
  const loadEpoch = Effect.fn('IndexedDbCacheStore.loadEpoch')(function* () {
    return (
      ((yield* idbRequest(() => databaseHandle.get('meta', 'epoch'))) as number | undefined) ?? 0
    );
  });
  const loadWorkspace = Effect.fn('IndexedDbCacheStore.loadWorkspace')(function* () {
    const [accountId, dialogs, drafts, draftDetails, draftRevisions, pending, epoch] =
      yield* Effect.all([
        loadAccountId(),
        loadDialogs(),
        loadDrafts(),
        loadDraftDetails(),
        loadDraftRevisions(),
        loadOutbox(),
        loadEpoch(),
      ]);
    return { accountId, dialogs, drafts, draftDetails, draftRevisions, pending, epoch };
  });
  const beginNewEpoch = Effect.fn('IndexedDbCacheStore.beginNewEpoch')(function* () {
    const database = databaseHandle;
    return yield* runAtomicWrite(
      () => database.transaction('meta', 'readwrite'),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          const current =
            ((yield* request(transaction.store.get('epoch'))) as number | undefined) ?? 0;
          const next = current + 1;
          yield* request(transaction.store.put(next, 'epoch'));
          return next;
        }),
    );
  });
  const commitLatestState = Effect.fn('IndexedDbCacheStore.commitLatestState')(function* (
    state: LatestStateCache,
  ) {
    const database = databaseHandle;
    return yield* runAtomicWrite(
      () => database.transaction(['meta', 'dialogs', 'messages', 'files'], 'readwrite'),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          const operations: Effect.Effect<unknown, CacheStoreError>[] = [];
          const meta = transaction.objectStore('meta');
          const dialogs = transaction.objectStore('dialogs');
          const messages = transaction.objectStore('messages');
          const files = transaction.objectStore('files');
          const current = ((yield* idbRequest(() => meta.get('epoch'))) as number | undefined) ?? 0;
          const epoch = current + 1;
          const cachedDialogs = state.dialogs.map((dialog) => ({ ...dialog, cacheEpoch: epoch }));

          operations.push(request(dialogs.clear()), request(messages.clear()));
          operations.push(
            request(meta.put(epoch, 'epoch')),
            request(meta.put(state.cursor, 'cursor')),
          );
          for (const dialog of cachedDialogs) operations.push(request(dialogs.put(dialog)));
          for (const key of state.discardBlobKeys ?? [])
            operations.push(request(files.delete(key)));
          for (const key of state.discardMetadataKeys ?? []) {
            operations.push(request(meta.delete(`${RESOURCE_METADATA_KEY_PREFIX}${key}`)));
          }
          yield* Effect.all(operations);
          return epoch;
        }),
    );
  });
  const loadDialogs = Effect.fn('IndexedDbCacheStore.loadDialogs')(function* () {
    return yield* idbRequest(() => databaseHandle.getAll('dialogs'));
  });
  const replaceDialogs = Effect.fn('IndexedDbCacheStore.replaceDialogs')(function* (
    dialogs: CachedDialog[],
  ) {
    const database = databaseHandle;
    yield* runAtomicWrite(
      () => database.transaction('dialogs', 'readwrite'),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          yield* request(transaction.store.clear());
          yield* Effect.all(dialogs.map((dialog) => request(transaction.store.put(dialog))));
        }),
    );
  });
  const putDialog = Effect.fn('IndexedDbCacheStore.putDialog')(function* (dialog: CachedDialog) {
    yield* idbRequest(() => databaseHandle.put('dialogs', dialog));
  });
  const loadMessages = Effect.fn('IndexedDbCacheStore.loadMessages')(function* (
    peerId: string,
    limit = DEFAULT_MESSAGE_LOAD_LIMIT,
  ) {
    const requested = Math.max(0, limit);
    if (requested === 0) return [];
    const transaction = databaseHandle.transaction('messages');
    const messages: CachedMessage[] = [];
    let cursor = yield* idbRequest(() =>
      transaction.store.index('byPeer').openCursor(IDBKeyRange.only(peerId), 'prev'),
    );
    while (cursor && messages.length < requested) {
      messages.push(cursor.value);
      const current = cursor;
      cursor = yield* idbRequest(() => current.continue());
    }
    yield* idbRequest(() => transaction.done);
    return messages.reverse();
  });
  const loadMessagesBefore = Effect.fn('IndexedDbCacheStore.loadMessagesBefore')(function* (
    peerId: string,
    beforeMessageId: number,
    limit = DEFAULT_MESSAGE_LOAD_LIMIT,
  ) {
    const requested = Math.max(0, limit);
    if (requested === 0) return [];
    const transaction = databaseHandle.transaction('messages');
    const messages: CachedMessage[] = [];
    let cursor = yield* idbRequest(() =>
      transaction.store.openCursor(
        IDBKeyRange.bound(
          [peerId, Number.MIN_SAFE_INTEGER],
          [peerId, beforeMessageId],
          false,
          true,
        ),
        'prev',
      ),
    );
    while (cursor && messages.length < requested) {
      messages.push(cursor.value);
      const current = cursor;
      cursor = yield* idbRequest(() => current.continue());
    }
    yield* idbRequest(() => transaction.done);
    return messages.reverse();
  });
  const loadMessage = Effect.fn('IndexedDbCacheStore.loadMessage')(function* (
    peerId: string,
    messageId: number,
  ) {
    return yield* idbRequest(() => databaseHandle.get('messages', [peerId, messageId]));
  });
  const replaceMessages = Effect.fn('IndexedDbCacheStore.replaceMessages')(function* (
    peerId: string,
    messages: CachedMessage[],
  ) {
    yield* writeReplacementMessages(peerId, messages).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!isQuotaError(error)) return yield* Effect.fail(error);
          yield* evictForMessageQuota();
          yield* writeReplacementMessages(peerId, messages);
        }),
      ),
    );
    yield* pruneMessageCache([peerId]);
  });
  const putMessages = Effect.fn('IndexedDbCacheStore.putMessages')(function* (
    messages: CachedMessage[],
  ) {
    if (messages.length === 0) return;
    yield* writeMessages(messages).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!isQuotaError(error)) return yield* Effect.fail(error);
          yield* evictForMessageQuota();
          yield* writeMessages(messages);
        }),
      ),
    );
    yield* pruneMessageCache([...new Set(messages.map(({ peerId }) => peerId))]);
  });
  const putMessage = Effect.fn('IndexedDbCacheStore.putMessage')(function* (
    message: CachedMessage,
  ) {
    yield* putMessages([message]);
  });
  const deleteMessages = Effect.fn('IndexedDbCacheStore.deleteMessages')(function* (
    peerId: string,
    messageIds: number[],
  ) {
    const database = databaseHandle;
    yield* runAtomicWrite(
      () => database.transaction('messages', 'readwrite'),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          yield* Effect.all(
            messageIds.map((id) => request(transaction.store.delete([peerId, id]))),
          );
        }),
    );
  });
  const findMessagePeers = Effect.fn('IndexedDbCacheStore.findMessagePeers')(function* (
    messageIds: number[],
  ) {
    const peers = new Set<string>();
    for (const id of new Set(messageIds)) {
      const messages = yield* idbRequest(() =>
        databaseHandle.getAllFromIndex('messages', 'byMessageId', IDBKeyRange.only(id)),
      );
      for (const message of messages) peers.add(message.peerId);
    }
    return [...peers];
  });
  function loadPinnedMessages(peerId: string) {
    return loadTimedValue<TelegramMessage[]>(`${PINNED_MESSAGES_KEY_PREFIX}${peerId}`);
  }
  function savePinnedMessages(peerId: string, messages: TelegramMessage[]) {
    return saveTimedValue(`${PINNED_MESSAGES_KEY_PREFIX}${peerId}`, messages);
  }
  const deletePinnedMessages = Effect.fn('IndexedDbCacheStore.deletePinnedMessages')(function* (
    peerId: string,
  ) {
    yield* idbRequest(() =>
      databaseHandle.delete('meta', `${PINNED_MESSAGES_KEY_PREFIX}${peerId}`),
    );
  });
  function loadGroupMembers(peerId: string) {
    return loadTimedValue<TelegramGroupMember[]>(`${GROUP_MEMBERS_KEY_PREFIX}${peerId}`);
  }
  function saveGroupMembers(peerId: string, members: TelegramGroupMember[]) {
    return saveTimedValue(`${GROUP_MEMBERS_KEY_PREFIX}${peerId}`, members);
  }
  const deleteGroupMembers = Effect.fn('IndexedDbCacheStore.deleteGroupMembers')(function* (
    peerId: string,
  ) {
    yield* idbRequest(() => databaseHandle.delete('meta', `${GROUP_MEMBERS_KEY_PREFIX}${peerId}`));
  });
  const loadMetadata = Effect.fn('IndexedDbCacheStore.loadMetadata')(function* <Value>(
    key: string,
  ) {
    return yield* loadTimedValue<Value>(`${RESOURCE_METADATA_KEY_PREFIX}${key}`);
  });
  const saveMetadata = Effect.fn('IndexedDbCacheStore.saveMetadata')(function* <Value>(
    key: string,
    value: Value,
  ) {
    yield* saveTimedValue(`${RESOURCE_METADATA_KEY_PREFIX}${key}`, value);
  });
  const deleteMetadata = Effect.fn('IndexedDbCacheStore.deleteMetadata')(function* (key: string) {
    yield* idbRequest(() => databaseHandle.delete('meta', `${RESOURCE_METADATA_KEY_PREFIX}${key}`));
  });
  const loadDrafts = Effect.fn('IndexedDbCacheStore.loadDrafts')(function* () {
    const drafts = yield* idbRequest(() => databaseHandle.getAll('drafts'));
    return Object.fromEntries(drafts.map(({ peerId, text }) => [peerId, text]));
  });
  const loadDraftRevisions = Effect.fn('IndexedDbCacheStore.loadDraftRevisions')(function* () {
    const drafts = yield* idbRequest(() => databaseHandle.getAll('drafts'));
    return Object.fromEntries(drafts.map(({ peerId, revision }) => [peerId, revision ?? 0]));
  });
  const loadDraftDetails = Effect.fn('IndexedDbCacheStore.loadDraftDetails')(function* () {
    const drafts = yield* idbRequest(() => databaseHandle.getAll('drafts'));
    return Object.fromEntries(
      drafts.flatMap(({ peerId, details }) => (details ? [[peerId, details]] : [])),
    );
  });
  const saveDraft = Effect.fn('IndexedDbCacheStore.saveDraft')(function* (
    peerId: string,
    text: string,
    revision = 0,
    details?: TelegramDraftDetails,
  ) {
    const database = databaseHandle;
    if (!text && !details) {
      yield* idbRequest(() => database.delete('drafts', peerId));
      return;
    }
    yield* idbRequest(() =>
      database.put('drafts', {
        peerId,
        text,
        updatedAt: Date.now(),
        revision,
        ...(details ? { details } : {}),
      }),
    );
  });
  const loadOutbox = Effect.fn('IndexedDbCacheStore.loadOutbox')(function* () {
    const sends = yield* idbRequest(() => databaseHandle.getAllFromIndex('outbox', 'byCreatedAt'));
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
  });
  const commitOutbox = Effect.fn('IndexedDbCacheStore.commitOutbox')(function* (
    sends: PendingSend | PendingSend[],
    draft?: DraftReservation,
  ) {
    const pending = Array.isArray(sends) ? sends : [sends];
    if (pending.length === 0) return;
    const database = databaseHandle;
    yield* runAtomicWrite(
      () => database.transaction(['outbox', 'drafts'], 'readwrite'),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          const outbox = transaction.objectStore('outbox');
          const drafts = transaction.objectStore('drafts');
          const current = draft ? yield* idbRequest(() => drafts.get(draft.peerId)) : undefined;
          yield* Effect.all(pending.map((send) => request(outbox.put(send))));
          if (
            draft &&
            current?.text === draft.text &&
            (current.revision ?? 0) === (draft.revision ?? 0)
          ) {
            yield* idbRequest(() => drafts.delete(draft.peerId));
          }
        }),
    );
  });
  const deletePending = Effect.fn('IndexedDbCacheStore.deletePending')(function* (id: string) {
    yield* idbRequest(() => databaseHandle.delete('outbox', id));
  });
  const loadBlob = Effect.fn('IndexedDbCacheStore.loadBlob')(function* (key: string) {
    return (yield* idbRequest(() => databaseHandle.get('files', key)))?.blob;
  });
  const saveBlob = Effect.fn('IndexedDbCacheStore.saveBlob')(function* (key: string, blob: Blob) {
    const database = databaseHandle;
    const record = { key, blob, savedAt: Date.now() };
    yield* idbRequest(() => database.put('files', record)).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!isQuotaError(error)) return yield* Effect.fail(error);
          yield* evictOldestBlobs(QUOTA_BLOB_EVICTION_COUNT);
          yield* idbRequest(() => database.put('files', record));
        }),
      ),
    );
    yield* pruneBlobCache();
  });
  const deleteBlob = Effect.fn('IndexedDbCacheStore.deleteBlob')(function* (key: string) {
    yield* idbRequest(() => databaseHandle.delete('files', key));
  });
  const loadTimedValue = Effect.fn('IndexedDbCacheStore.loadTimedValue')(function* <T>(
    key: string,
  ) {
    return yield* idbRequest(
      () => databaseHandle.get('meta', key) as Promise<TimedCacheValue<T> | undefined>,
    );
  });
  const saveTimedValue = Effect.fn('IndexedDbCacheStore.saveTimedValue')(function* <T>(
    key: string,
    value: T,
  ) {
    yield* idbRequest(() => databaseHandle.put('meta', { value, savedAt: Date.now() }, key));
  });
  function isQuotaError(error: unknown) {
    const cause =
      typeof error === 'object' && error !== null && 'cause' in error ? error.cause : error;
    return (
      typeof cause === 'object' &&
      cause !== null &&
      'name' in cause &&
      cause.name === 'QuotaExceededError'
    );
  }
  const writeReplacementMessages = Effect.fn('IndexedDbCacheStore.writeReplacementMessages')(
    function* (peerId: string, messages: CachedMessage[]) {
      const database = databaseHandle;
      yield* runAtomicWrite(
        () => database.transaction('messages', 'readwrite'),
        ({ transaction, request }) =>
          Effect.gen(function* () {
            const keys = yield* request(transaction.store.index('byPeer').getAllKeys(peerId));
            yield* Effect.all(keys.map((key) => request(transaction.store.delete(key))));
            for (const message of messages) yield* request(transaction.store.put(message));
          }),
      );
    },
  );
  const writeMessages = Effect.fn('IndexedDbCacheStore.writeMessages')(function* (
    messages: CachedMessage[],
  ) {
    const database = databaseHandle;
    yield* runAtomicWrite(
      () => database.transaction('messages', 'readwrite'),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          for (const message of messages) yield* request(transaction.store.put(message));
        }),
    );
  });
  const pruneMessageCache = Effect.fn('IndexedDbCacheStore.pruneMessageCache')(function* (
    peerIds: string[],
  ) {
    const database = databaseHandle;
    yield* runAtomicWrite(
      () => database.transaction('messages', 'readwrite'),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          for (const peerId of peerIds) {
            const index = transaction.store.index('byPeer');
            let excess =
              (yield* request(index.count(IDBKeyRange.only(peerId)))) -
              MAX_CACHED_MESSAGES_PER_PEER;
            if (excess <= 0) continue;
            let cursor = yield* request(index.openCursor(IDBKeyRange.only(peerId)));
            while (cursor && excess > 0) {
              yield* request(cursor.delete());
              excess -= 1;
              cursor = yield* request(cursor.continue());
            }
          }

          let excess = (yield* request(transaction.store.count())) - MAX_CACHED_MESSAGES;
          if (excess > 0) {
            let cursor = yield* request(transaction.store.index('byDate').openCursor());
            while (cursor && excess > 0) {
              yield* request(cursor.delete());
              excess -= 1;
              cursor = yield* request(cursor.continue());
            }
          }
        }),
    );
  });
  const evictForMessageQuota = Effect.fn('IndexedDbCacheStore.evictForMessageQuota')(function* () {
    yield* Effect.all([
      evictOldestMessages(QUOTA_MESSAGE_EVICTION_COUNT),
      evictOldestBlobs(QUOTA_BLOB_EVICTION_COUNT),
    ]);
  });
  const evictOldestMessages = Effect.fn('IndexedDbCacheStore.evictOldestMessages')(function* (
    count: number,
  ) {
    const database = databaseHandle;
    yield* runAtomicWrite(
      () => database.transaction('messages', 'readwrite'),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          let remaining = count;
          let cursor = yield* request(transaction.store.index('byDate').openCursor());
          while (cursor && remaining > 0) {
            yield* request(cursor.delete());
            remaining -= 1;
            cursor = yield* request(cursor.continue());
          }
        }),
    );
  });
  const evictOldestBlobs = Effect.fn('IndexedDbCacheStore.evictOldestBlobs')(function* (
    count: number,
  ) {
    const database = databaseHandle;
    yield* runAtomicWrite(
      () => database.transaction('files', 'readwrite'),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          const records = yield* request(transaction.store.getAll());
          records.sort((left, right) => left.savedAt - right.savedAt);
          yield* Effect.all(
            records.slice(0, count).map(({ key }) => request(transaction.store.delete(key))),
          );
        }),
    );
  });
  const pruneBlobCache = Effect.fn('IndexedDbCacheStore.pruneBlobCache')(function* () {
    const database = databaseHandle;
    yield* runAtomicWrite(
      () => database.transaction('files', 'readwrite'),
      ({ transaction, request }) =>
        Effect.gen(function* () {
          const records = yield* request(transaction.store.getAll());
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
          yield* Effect.all(removals.map((key) => request(transaction.store.delete(key))));
        }),
    );
  });
  function formatBytes(bytes: number) {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${Math.ceil(bytes / (1024 * 1024))} MB`;
    return `${Math.ceil(bytes / 1024)} KB`;
  }
  return {
    captureCheckpoint: captureCheckpoint,
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
    loadWorkspace: loadWorkspace,
    beginNewEpoch: beginNewEpoch,
    commitLatestState: commitLatestState,
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
export type IndexedDbCacheStore = ReturnType<typeof makeIndexedDbCacheStoreModule>;

export const createIndexedDbCacheStore = Effect.fn('IndexedDbCacheStore.make')(function* (
  name = 'televecha',
) {
  const database = yield* openTeleVechaDatabase(name);
  return makeIndexedDbCacheStoreModule(database);
});
