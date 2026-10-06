import {
  available,
  collection,
  program,
  resourceError,
  type Snapshot,
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
  Snapshot<InfiniteData<TelegramSearchPage, SearchCursor>>,
  unknown
>;
export interface SearchPanelProps {
  dialogs: readonly TelegramDialog[];
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
  readonly host: Snapshot<SearchPanelProps>;
  readonly query: string;
  readonly global: boolean;
  readonly submitted: string;
}
export interface SearchModel {
  readonly props: SearchInput;
  readonly loadingMore: boolean;
  readonly moreError: string;
}

/** The submitted search; global searches share results across chats. */
export const searchArgs = (input: Snapshot<SearchInput>): MessageSearchArgs | undefined =>
  input.submitted
    ? {
        peerId: input.global ? '' : input.host.activePeerId,
        text: input.submitted,
        global: input.global,
      }
    : undefined;
/** Loaded rows in page order; a message repeated by a later page is shown once. */
export const searchRows = (result: SearchResults) => pageMessages(available(result)?.pages ?? []);
export const searchError = resourceError;

type MoreMessage = { type: 'MoreLoaded' } | { type: 'MoreFailed'; error: string };
const change = (
  model: Snapshot<SearchModel>,
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
        commands: [
          {
            key: commandHost,
            policy: 'replace',
            effect: Effect.sync(() => props.host.refresh(args)),
          },
        ],
      }
    : { model: next };
};
const more = (model: Snapshot<SearchModel>): Transition<SearchModel, MoreMessage> => {
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
  Query: (model, query: string) => change(model, { query, submitted: '' }),
  Scope: (model, global: boolean) =>
    change(model, { global, submitted: model.props.query.trim() }, true),
  Submit: (model) => change(model, { submitted: model.props.query.trim() }, true),
  Context: (model, host: Snapshot<SearchPanelProps>) =>
    change(model, {
      host,
      submitted:
        model.props.host.activePeerId === host.activePeerId
          ? model.props.submitted
          : model.props.query.trim(),
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
export type SearchMessage = ActionMessage<typeof searchActions> | MoreMessage;

export function createSearchProgram(props: Snapshot<SearchPanelProps>) {
  return program<SearchModel, SearchMessage>({
    initial: {
      props: { host: props, query: '', global: false, submitted: '' },
      loadingMore: false,
      moreError: '',
    },
    update: (model, message) =>
      'args' in message
        ? searchActions.update(model, message)
        : message.type === 'MoreLoaded'
          ? { model: { ...model, loadingMore: false } }
          : { model: { ...model, loadingMore: false, moreError: message.error } },
    onDefect: (cause) => console.error('Search command failed', cause),
  });
}
