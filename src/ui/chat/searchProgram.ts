import type { TelegramPeerSearchResult, TelegramSearchFilters } from '../../telegram/types';
import type { MediaAssets } from '../media/mediaAssets';
import { searchDateRange } from './searchFilters';
import {
  available,
  collection,
  program,
  resourceError,
  type Source,
  type Transition,
} from 'effectweb';
import { defineActions, type ActionMessage } from '../shared/composition';
import type { InfiniteData } from '@effectweb/query';
import type * as AsyncResult from 'effect/reactivity/AsyncResult';
import { Cause, Effect } from 'effect';
import type { TelegramDialog, TelegramMessage, TelegramSearchPage } from '../../telegram/types';
import { pageMessages, type MessageSearchArgs, type SearchCursor } from '../app/queries';

const commandHost = 'host';
const commandMore = 'more';

export type SearchResults = AsyncResult.AsyncResult<
  InfiniteData<TelegramSearchPage, SearchCursor>,
  unknown
>;
export interface SearchPanelProps {
  dialogs: readonly TelegramDialog[];
  compact?: boolean;
  media?: MediaAssets;
  online?: boolean;
  searchPeople?: (query: string) => Effect.Effect<TelegramPeerSearchResult[], unknown>;
  searchMembers?: (
    peerId: string,
    query: string,
    offset: number,
  ) => Effect.Effect<import('../../telegram/types').TelegramGroupMemberPage, unknown>;
  activePeerId: string;
  /** Cached results for one submitted search. */
  results: (args: MessageSearchArgs) => Source<SearchResults>;
  more: (args: MessageSearchArgs) => Effect.Effect<unknown, unknown>;
  refresh: (args: MessageSearchArgs) => void;
  openResult: (message: TelegramMessage) => void;
  close: () => void;
}
export const messageIdentity = (message: TelegramMessage) => `${message.peerId}:${message.id}`;
export const searchMessages = collection(messageIdentity);
interface SearchInput {
  readonly host: SearchPanelProps;
  readonly query: string;
  readonly global: boolean;
  readonly submitted: string;
  readonly ready: boolean;
  readonly filters: TelegramSearchFilters;
  readonly fromDate: string;
  readonly untilDate: string;
  readonly dateError: string;
}
export interface SearchModel {
  readonly props: SearchInput;
  readonly loadingMore: boolean;
  readonly moreError: string;
}

/** The submitted search; global searches share results across chats. */
export const searchArgs = (input: SearchInput): MessageSearchArgs | undefined => {
  if (!input.ready || input.dateError) return undefined;
  const filters = { ...input.filters, ...searchDateRange(input.fromDate, input.untilDate) };
  const hasFilters = Object.values(filters).some((value) => value !== undefined);
  return input.submitted || hasFilters
    ? {
        peerId: input.global ? '' : input.host.activePeerId,
        text: input.submitted,
        global: input.global,
        ...(hasFilters ? { filters } : {}),
      }
    : undefined;
};
/** Loaded rows in page order; a message repeated by a later page is shown once. */
export const searchRows = (result: SearchResults) => pageMessages(available(result)?.pages ?? []);
export const searchError = resourceError;

type MoreMessage = { type: 'MoreLoaded' } | { type: 'MoreFailed'; error: string };
const change = (
  model: SearchModel,
  input: Partial<SearchInput>,
  refresh: boolean = false,
): Transition<SearchModel, never> => {
  const props = { ...model.props, ...input } as SearchInput;
  const args = searchArgs(props);
  const next = { props, loadingMore: false, moreError: '' };
  // Resubmitting the same search asks the cache for fresh results.
  return refresh && args && JSON.stringify(args) === JSON.stringify(searchArgs(model.props))
    ? {
        model: next,
        cancel: [commandMore, 'typing'],
        commands: [
          {
            key: commandHost,
            policy: 'replace',
            effect: Effect.sync(() => props.host.refresh(args)),
          },
        ],
      }
    : { model: next, cancel: [commandMore, 'typing'] };
};
const more = (model: SearchModel): Transition<SearchModel, MoreMessage> => {
  const args = searchArgs(model.props);
  return args
    ? {
        model: { ...model, loadingMore: true, moreError: '' },
        commands: [
          {
            key: commandMore,
            policy: 'drop',
            effect: model.props.host
              .more(args)
              .pipe(
                Effect.matchCause({
                  onSuccess: (): MoreMessage => ({ type: 'MoreLoaded' }),
                  onFailure: (cause): MoreMessage => ({
                    type: 'MoreFailed',
                    error: failureMessage(cause),
                  }),
                }),
              ),
          },
        ],
      }
    : { model };
};
const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

export const searchActions = defineActions<SearchModel>()({
  Query: (model, query: string): Transition<SearchModel, { type: 'AutoSearch' }> => ({
    model: {
      ...model,
      props: { ...model.props, query, ready: false, submitted: '' },
      loadingMore: false,
      moreError: '',
    },
    cancel: [commandMore],
    commands: [
      {
        key: 'typing',
        policy: 'replace',
        effect: Effect.sleep(250).pipe(Effect.as({ type: 'AutoSearch' as const })),
      },
    ],
  }),
  Filters: (model, filters: TelegramSearchFilters) =>
    change(model, { filters, ready: true, submitted: model.props.query.trim() }),
  Dates: (model, fromDate: string, untilDate: string) => {
    let dateError = '';
    try {
      searchDateRange(fromDate, untilDate);
    } catch (error) {
      dateError = (error as Error).message;
    }
    return change(model, {
      fromDate,
      untilDate,
      dateError,
      ready: true,
      submitted: model.props.query.trim(),
    });
  },
  ClearFilters: (model) =>
    change(model, {
      filters: {},
      fromDate: '',
      untilDate: '',
      dateError: '',
      ready: true,
      submitted: model.props.query.trim(),
    }),
  Scope: (model, global: boolean) =>
    change(
      model,
      {
        global,
        filters: { ...model.props.filters, fromPeer: undefined, chatType: undefined },
        ready: true,
        submitted: model.props.query.trim(),
      },
      true,
    ),
  Submit: (model) => change(model, { ready: true, submitted: model.props.query.trim() }, true),
  Context: (model, host: SearchPanelProps) =>
    model.props.host.activePeerId === host.activePeerId
      ? { model: { ...model, props: { ...model.props, host } } }
      : change(model, {
          host,
          filters: { ...model.props.filters, fromPeer: undefined },
          submitted: model.props.query.trim(),
        }),
  More: more,
  /** Retry the failed page, or the search itself. */
  Retry: (model) => {
    if (model.moreError) return more(model);
    const args = searchArgs(model.props);
    return {
      model,
      commands: args
        ? [
            {
              key: commandHost,
              policy: 'replace',
              effect: Effect.sync(() => model.props.host.refresh(args)),
            },
          ]
        : [],
    };
  },
  Open: (model, message: TelegramMessage) => ({
    model,
    commands: [
      {
        key: commandHost,
        policy: 'replace',
        effect: Effect.sync(() => model.props.host.openResult(message)),
      },
    ],
  }),
  Close: (model) => ({
    model,
    commands: [
      { key: commandHost, policy: 'replace', effect: Effect.sync(() => model.props.host.close()) },
    ],
  }),
});
export type SearchMessage =
  | ActionMessage<typeof searchActions>
  | MoreMessage
  | { type: 'AutoSearch' };

export function createSearchProgram(props: SearchPanelProps) {
  return program<SearchModel, SearchMessage>({
    initial: {
      props: {
        host: props,
        query: '',
        global: false,
        submitted: '',
        ready: false,
        filters: {},
        fromDate: '',
        untilDate: '',
        dateError: '',
      },
      loadingMore: false,
      moreError: '',
    },
    update: (model, message) =>
      'args' in message
        ? searchActions.update(model, message)
        : message.type === 'AutoSearch'
          ? change(model, { ready: true, submitted: model.props.query.trim() })
          : message.type === 'MoreLoaded'
            ? { model: { ...model, loadingMore: false } }
            : { model: { ...model, loadingMore: false, moreError: message.error } },
    onDefect: (cause) => console.error('Search command failed', cause),
  });
}
