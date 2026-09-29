import { Context, Effect } from 'effect';
import { uiRuntime } from 'effectweb';
import { makeQueryCache } from '@effectweb/query';
import { describe, expect, it } from 'vitest';
import type {
  TelegramMessage,
  TelegramSearchOffset,
  TelegramSearchPage,
} from '../../telegram/types';
import { QueryLoaders, querySources } from '../app/queries';
import {
  createSearchProgram,
  searchActions,
  searchArgs,
  searchRows,
  type SearchPanelProps,
} from './searchProgram';

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
type Search = (
  peerId: string,
  text: string,
  global: boolean,
  offset: TelegramSearchOffset | undefined,
) => Effect.Effect<TelegramSearchPage, unknown>;
const unused = () => Effect.die('unused');

/** A search host backed by a real query cache, as in the app. */
function hostFor(search: Search): SearchPanelProps {
  const cache = makeQueryCache(
    uiRuntime(
      Context.make(QueryLoaders, {
        searchMessages: search,
        reactionPeople: unused,
        customEmoji: unused,
        previewPhoto: unused,
        sharedMedia: unused,
      }),
    ),
  );
  const sources = querySources(cache);
  return {
    dialogs: [],
    activePeerId: 'alice',
    close() {},
    openResult() {},
    results: sources.messageSearch,
    more: sources.moreMessages,
    refresh: sources.refreshMessages,
  };
}
/** Rows the view shows for the program's current search. */
const shown = (host: SearchPanelProps, source: ReturnType<typeof createSearchProgram>) => {
  const args = searchArgs(source.model().props);
  return args ? searchRows(host.results(args).model()).map((item) => item.id) : [];
};

describe('compiled search workflow', () => {
  it.each(['sync', 'async', 'promise-adapter'])(
    'accepts a %s producer without changing model or view',
    async (kind) => {
      const data = page([1]);
      const host = hostFor(() =>
        kind === 'sync'
          ? Effect.succeed(data)
          : kind === 'async'
            ? Effect.succeed(data).pipe(Effect.delay(0))
            : Effect.tryPromise(() => Promise.resolve(data)),
      );
      const source = createSearchProgram(host);
      source.send(searchActions.message.Query('hello'));
      source.send(searchActions.message.Submit());
      shown(host, source);
      await settle();
      expect(shown(host, source)).toEqual([1]);
      source.dispose();
    },
  );
  it('keeps successful rows through a failed refresh, and retries it', async () => {
    let calls = 0;
    const host = hostFor(() =>
      ++calls === 2 ? Effect.fail('offline') : Effect.succeed(page([1])),
    );
    const source = createSearchProgram(host);
    source.send(searchActions.message.Query('hello'));
    source.send(searchActions.message.Submit());
    const stop = host.results(searchArgs(source.model().props)!).subscribe(() => {});
    await settle();
    source.send(searchActions.message.Submit());
    await settle();
    const args = searchArgs(source.model().props)!;
    expect(host.results(args).model()._tag).toBe('Failure');
    expect(shown(host, source)).toEqual([1]);
    source.send(searchActions.message.Retry());
    await settle();
    expect(host.results(args).model()._tag).toBe('Success');
    expect(calls).toBe(3);
    stop();
    source.dispose();
  });
  it('appends the next page once, without repeating a message', async () => {
    const host = hostFor((_peer, _text, _global, offset) =>
      Effect.succeed(offset ? page([3, 4]) : page([2, 3], true)),
    );
    const source = createSearchProgram(host);
    source.send(searchActions.message.Query('new'));
    source.send(searchActions.message.Submit());
    const stop = host.results(searchArgs(source.model().props)!).subscribe(() => {});
    await settle();
    expect(shown(host, source)).toEqual([2, 3]);
    source.send(searchActions.message.More());
    await settle();
    expect(source.model().loadingMore).toBe(false);
    expect(shown(host, source)).toEqual([2, 3, 4]);
    stop();
    source.dispose();
  });
  it('waits for submission, clears changed queries, and scopes chat searches', () => {
    const host = hostFor(() => Effect.succeed(page([1])));
    const source = createSearchProgram(host);
    source.send(searchActions.message.Query('  hello  '));
    expect(searchArgs(source.model().props)).toBeUndefined();
    source.send(searchActions.message.Submit());
    expect(searchArgs(source.model().props)).toEqual({
      peerId: 'alice',
      text: 'hello',
      global: false,
    });
    source.send(searchActions.message.Context({ ...host, activePeerId: 'bob' }));
    expect(searchArgs(source.model().props)?.peerId).toBe('bob');
    source.send(searchActions.message.Scope(true));
    expect(searchArgs(source.model().props)).toEqual({ peerId: '', text: 'hello', global: true });
    source.send(searchActions.message.Context({ ...host, activePeerId: 'carol' }));
    expect(searchArgs(source.model().props)?.peerId).toBe('');
    source.send(searchActions.message.Query('changed'));
    expect(searchArgs(source.model().props)).toBeUndefined();
    source.send(searchActions.message.Query('  '));
    source.send(searchActions.message.Submit());
    expect(searchArgs(source.model().props)).toBeUndefined();
    source.dispose();
  });

  it('invokes current host actions without an artificial completion message', async () => {
    let opened = 0;
    let closed = 0;
    const host = hostFor(() => Effect.succeed(page([])));
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
