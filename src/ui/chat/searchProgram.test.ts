import { Context, Effect } from 'effect';
import { queryCache } from '@effectweb/query';
import { describe, expect, it } from 'vitest';
import type {
  TelegramSearchFilters,
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
  filters?: TelegramSearchFilters,
) => Effect.Effect<TelegramSearchPage, unknown>;
const unused = () => Effect.die('unused');

/** A search host backed by a real query cache, as in the app. */
function hostFor(search: Search): SearchPanelProps {
  const cache = queryCache(
    Context.make(QueryLoaders, {
      searchMessages: search,
      reactionPeople: unused,
      customEmoji: unused,
      previewPhoto: unused,
      sharedMedia: unused,
    }),
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
  it('searches by filters without text and keeps each combination in its own cache', async () => {
    const received: unknown[] = [];
    const host = hostFor((_peer, _text, _global, _offset, filters) => {
      received.push(filters);
      return Effect.succeed(page([filters?.kind === 'photos' ? 1 : 2]));
    });
    const source = createSearchProgram(host);
    source.send(searchActions.message.Filters({ kind: 'photos' }));
    shown(host, source);
    await settle();
    expect(shown(host, source)).toEqual([1]);
    source.send(searchActions.message.Filters({ kind: 'videos' }));
    shown(host, source);
    await settle();
    expect(shown(host, source)).toEqual([2]);
    expect(received).toEqual([{ kind: 'photos' }, { kind: 'videos' }]);
    source.send(searchActions.message.ClearFilters());
    expect(searchArgs(source.model().props)).toBeUndefined();
    source.dispose();
  });

  it('clears incompatible sender restrictions when switching to all chats', () => {
    const source = createSearchProgram(hostFor(() => Effect.succeed(page([]))));
    source.send(
      searchActions.message.Filters({ kind: 'files', fromPeer: { id: 'u:5', kind: 'user' } }),
    );
    source.send(searchActions.message.Scope(true));
    expect(searchArgs(source.model().props)).toEqual({
      peerId: '',
      text: '',
      global: true,
      filters: { kind: 'files', fromPeer: undefined, chatType: undefined },
    });
    source.send(searchActions.message.Dates('2026-11-07', '2026-11-01'));
    expect(source.model().props.dateError).toBeTruthy();
    expect(searchArgs(source.model().props)).toBeUndefined();
    source.dispose();
  });

  it('automatically submits after typing settles', async () => {
    const source = createSearchProgram(hostFor(() => Effect.succeed(page([]))));
    source.send(searchActions.message.Query('photo'));
    expect(searchArgs(source.model().props)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(searchArgs(source.model().props)?.text).toBe('photo');
    source.dispose();
  });

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

it('gives each topic its own search identity and removes topic scope for global search', () => {
  const host = {
    ...hostFor(() => Effect.succeed(page([]))),
    activeTopicId: 10,
    activeTopicTitle: 'Development',
  };
  const source = createSearchProgram(host);
  source.send(searchActions.message.Query('message'));
  source.send(searchActions.message.Submit());
  expect(searchArgs(source.model().props)?.filters).toMatchObject({ topicId: 10 });
  source.send(searchActions.message.Context({ ...host, activeTopicId: 20 }));
  expect(searchArgs(source.model().props)?.filters).toMatchObject({ topicId: 20 });
  source.send(searchActions.message.Scope(true));
  expect(searchArgs(source.model().props)?.filters?.topicId).toBeUndefined();
  source.dispose();
});

it('scopes saved message searches to their original chat and clears it for global search', () => {
  const host = {
    ...hostFor(() => Effect.succeed(page([]))),
    activeSavedPeer: { id: 'c:10', kind: 'channel' as const, accessHash: '100' },
    activeSavedTitle: 'Project',
  };
  const source = createSearchProgram(host);
  source.send(searchActions.message.Query('idea'));
  source.send(searchActions.message.Submit());
  expect(searchArgs(source.model().props)?.filters?.savedPeer?.id).toBe('c:10');
  source.send(
    searchActions.message.Context({
      ...host,
      activeSavedPeer: { ...host.activeSavedPeer, id: 'c:20' },
    }),
  );
  expect(searchArgs(source.model().props)?.filters?.savedPeer?.id).toBe('c:20');
  source.send(searchActions.message.Scope(true));
  expect(searchArgs(source.model().props)?.filters?.savedPeer).toBeUndefined();
  source.dispose();
});

it('opens saved tag searches without text and drops tags when switching scope or chat', () => {
  const host = {
    ...hostFor(unused),
    activePeerId: 'u:self',
    savedTagSearch: { reaction: '⭐', request: 1 },
  };
  const source = createSearchProgram(host);
  expect(searchArgs(source.model().props)).toMatchObject({
    peerId: 'u:self',
    text: '',
    filters: { savedReactions: ['⭐'] },
  });
  source.send(searchActions.message.Scope(true));
  expect(searchArgs(source.model().props)).toBeUndefined();
  source.send(
    searchActions.message.Context({ ...host, savedTagSearch: { reaction: '👍', request: 2 } }),
  );
  expect(searchArgs(source.model().props)).toMatchObject({
    global: false,
    filters: { savedReactions: ['👍'] },
  });
  source.send(
    searchActions.message.Context({ ...host, activePeerId: 'u:other', savedTagSearch: undefined }),
  );
  expect(searchArgs(source.model().props)).toBeUndefined();
  Effect.runSync(source.close());
});
