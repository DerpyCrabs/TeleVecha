import { fromPromise } from 'effectweb/load';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import type { TelegramMessage, TelegramSearchPage } from '../../telegram/types';
import { createSearchProgram, searchActions, searchPage } from './searchProgram';

const message = (id: number): TelegramMessage => ({
  id,
  peerId: 'alice',
  senderId: 'alice',
  text: `Message ${id}`,
  date: 1,
  outgoing: false,
});
const page = (ids: number[], hasMore: boolean = false): TelegramSearchPage => ({
  messages: ids.map(message),
  hasMore,
  nextOffset: hasMore ? { messageId: ids.at(-1)! } : undefined,
});
const settle = () => new Promise((done) => setTimeout(done, 0));

describe('compiled search workflow', () => {
  it.each(['sync', 'async', 'promise-adapter'])(
    'accepts a %s producer without changing model or view',
    async (kind) => {
      const data = page([1]);
      const source = createSearchProgram({
        dialogs: [],
        activePeerId: 'alice',
        close() {},
        openResult() {},
        search: () =>
          kind === 'sync'
            ? Effect.succeed(data)
            : kind === 'async'
              ? Effect.succeed(data).pipe(Effect.delay(0))
              : fromPromise(() => Promise.resolve(data)),
      });
      source.send(searchActions.message.Query('hello'));
      source.send(searchActions.message.Submit());
      await settle();
      expect(searchPage(source.model())?.items).toEqual(data.messages);
      source.dispose();
    },
  );
  it('keeps successful rows through a failed refresh, and retries the failed operation', async () => {
    let calls = 0;
    const first = page([1]);
    const source = createSearchProgram({
      dialogs: [],
      activePeerId: 'alice',
      close() {},
      openResult() {},
      search: () => (++calls === 2 ? Effect.fail('offline') : Effect.succeed(first)),
    });
    source.send(searchActions.message.Query('hello'));
    source.send(searchActions.message.Submit());
    await settle();
    source.send(searchActions.message.Submit());
    expect(searchPage(source.model())?.items).toEqual(first.messages);
    await settle();
    expect(source.model().result._tag).toBe('Failure');
    expect(searchPage(source.model())?.items).toEqual(first.messages);
    source.send({ type: 'Retry' });
    await settle();
    expect(source.model().result._tag).toBe('Success');
    expect(calls).toBe(3);
    source.dispose();
  });
  it('discards a stale completion after query changes, then deduplicates appended pages', async () => {
    let resolve!: (page: TelegramSearchPage) => void;
    let calls = 0;
    const source = createSearchProgram({
      dialogs: [],
      activePeerId: 'alice',
      close() {},
      openResult() {},
      search: () =>
        ++calls === 1
          ? fromPromise(
              () =>
                new Promise<TelegramSearchPage>((done) => {
                  resolve = done;
                }),
            )
          : Effect.succeed(page(calls === 2 ? [2, 3] : [3, 4], calls === 2)),
    });
    source.send(searchActions.message.Query('old'));
    source.send(searchActions.message.Submit());
    await settle();
    source.send(searchActions.message.Query('new'));
    source.send(searchActions.message.Submit());
    await settle();
    resolve(page([99]));
    await settle();
    expect(searchPage(source.model())!.items.map((item) => item.id)).toEqual([2, 3]);
    source.send({ type: 'More' });
    await settle();
    expect(searchPage(source.model())!.items.map((item) => item.id)).toEqual([2, 3, 4]);
    source.dispose();
  });
  it('waits for submission, clears changed queries, and scopes result identity to the chat', async () => {
    let calls = 0;
    const host = {
      dialogs: [],
      activePeerId: 'alice',
      close() {},
      openResult() {},
      search: () => Effect.succeed(page([++calls])).pipe(Effect.delay(0)),
    };
    const source = createSearchProgram(host);
    source.send(searchActions.message.Query('  hello  '));
    expect(calls).toBe(0);
    source.send(searchActions.message.Submit());
    await settle();
    expect(source.model().props.submitted).toBe('hello');
    source.send(searchActions.message.Context({ ...host, activePeerId: 'bob' }));
    expect(searchPage(source.model())).toBeUndefined();
    await settle();
    expect(calls).toBe(2);
    source.send(searchActions.message.Scope(true));
    await settle();
    expect(calls).toBe(3);
    source.send(searchActions.message.Context({ ...host, activePeerId: 'carol' }));
    await settle();
    expect(calls).toBe(3);
    source.send(searchActions.message.Query('changed'));
    expect(searchPage(source.model())).toBeUndefined();
    expect(source.model().props.submitted).toBe('');
    expect(calls).toBe(3);
    source.send(searchActions.message.Query('  '));
    source.send(searchActions.message.Submit());
    await settle();
    expect(calls).toBe(3);
    expect(source.model().result.waiting).toBe(false);
    source.dispose();
  });

  it('invokes current host actions without an artificial completion message', async () => {
    let opened = 0;
    let closed = 0;
    const host = {
      dialogs: [],
      activePeerId: 'alice',
      close() {},
      openResult() {},
      search: () => Effect.succeed(page([])),
    };
    const source = createSearchProgram(host);
    source.send(
      searchActions.message.Context({
        ...host,
        close() {
          closed++;
        },
        openResult() {
          opened++;
        },
      }),
    );
    let publications = 0;
    const release = source.subscribe(() => {
      publications++;
    });
    source.send(searchActions.message.Open(message(1)));
    await settle();
    source.send(searchActions.message.Close());
    await settle();
    expect(opened).toBe(1);
    expect(closed).toBe(1);
    expect(publications).toBe(0);
    release();
    source.dispose();
  });
});
