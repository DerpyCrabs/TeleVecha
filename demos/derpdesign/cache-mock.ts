import { Effect } from 'effect';
import { makeMemoryCacheStore } from '../../src/telegram/persistence/memoryStore';
/** All demo cache state belongs to this page, using the project's tested fixture store. */
export const createIndexedDbCacheStore = () =>
  Effect.sync(() => ({
    ...makeMemoryCacheStore(),
    captureCheckpoint: () =>
      Effect.fail(new Error('Debug report export is outside this demo fixture')),
  }));
