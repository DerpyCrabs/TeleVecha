import 'fake-indexeddb/auto';
import { Effect, Scheduler } from 'effect';
import { expect, it } from 'vitest';
import { createIndexedDbCacheStore } from './store';

it('commits account and blob writes when the caller yields between requests', async () => {
  const saved = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* createIndexedDbCacheStore('store-scheduler-' + crypto.randomUUID());
        yield* store.claimAccount('owner');
        yield* store.saveBlob('wallpaper:peer', new Blob(['wallpaper']));
        return [yield* store.loadAccountId(), (yield* store.loadBlob('wallpaper:peer'))?.size];
      }),
    ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8)),
  );
  expect(saved).toEqual(['owner', 9]);
});
