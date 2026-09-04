import { describe, expect, it } from 'vitest';
import { Deferred, Effect } from 'effect';

import { makeRequestJournal, type PendingRequest } from './requestJournal';

const request = (id: string) =>
  Deferred.make<unknown, Error>().pipe(
    Effect.map(
      (result) =>
        ({
          id,
          method: 'send' as const,
          args: [],
          createdAt: 1,
          result,
        }) satisfies PendingRequest<'send'>,
    ),
  );

describe('requestJournal', () => {
  it('takes pending requests once and rejects a selected owner batch', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const journal = makeRequestJournal<'send'>(2);
        const first = yield* request('first');
        const second = { ...(yield* request('second')), sentTo: 'owner-b' };
        journal.add(first);
        journal.add(second);

        expect(journal.takePending('first')).toBe(first);
        expect(journal.takePending('first')).toBeUndefined();
        yield* journal.rejectPending(
          (entry) => entry.sentTo === 'owner-b',
          new Error('owner closed'),
        );

        expect((yield* Deferred.await(second.result).pipe(Effect.result))._tag).toBe('Failure');
        expect(journal.pendingCount()).toBe(0);
      }),
    ));

  it('deduplicates active requests and bounds completed responses', () => {
    const journal = makeRequestJournal<'send'>(2);

    expect(journal.begin('active')).toBe(true);
    expect(journal.begin('active')).toBe(false);
    journal.finish('active');
    expect(journal.begin('active')).toBe(true);

    journal.remember('one', { result: 1 });
    journal.remember('two', { result: 2 });
    journal.remember('three', { result: 3 });
    expect(journal.completed('one')).toBeUndefined();
    expect(journal.completed('two')).toEqual({ result: 2 });
    expect(journal.completed('three')).toEqual({ result: 3 });
  });
});
