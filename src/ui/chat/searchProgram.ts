import {
  commandSlot,
  available,
  collection,
  effectCommand,
  program,
  resourceError,
  actionCommand,
  type Snapshot,
  type Source,
} from 'effectweb';
import { defineActions, type ActionMessage } from 'effectweb/advanced';
import type { InfiniteData } from '@effectweb/query';
import type * as AsyncResult from 'effect/reactivity/AsyncResult';
import { Cause, Effect } from 'effect';
import type { TelegramDialog, TelegramMessage, TelegramSearchPage } from '../../telegram/types';
import { pageMessages, type MessageSearchArgs, type SearchCursor } from '../app/queries';

const commandHost = commandSlot('host');
const commandMore = commandSlot('more');

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
  readonly host: SearchPanelProps;
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

const change = (
  model: Snapshot<SearchModel>,
  input: Partial<SearchInput>,
  refresh: boolean = false,
) => {
  const props = { ...model.props, ...input } as SearchInput;
  const args = searchArgs(props);
  const next = { props, loadingMore: false, moreError: '' };
  // Resubmitting the same search asks the cache for fresh results.
  return refresh && args && JSON.stringify(args) === JSON.stringify(searchArgs(model.props))
    ? {
        model: next,
        commands: [
          actionCommand(commandHost, () => Effect.sync(() => props.host.refresh(args)), 'replace'),
        ],
      }
    : { model: next };
};
const more = (model: Snapshot<SearchModel>) => {
  const args = searchArgs(model.props);
  return args
    ? {
        model: { ...model, loadingMore: true, moreError: '' },
        commands: [
          effectCommand(commandMore, () => model.props.host.more(args), {
            policy: 'drop',
            onSuccess: () => ({ type: 'MoreLoaded' }) as const,
            onFailure: (cause) => ({ type: 'MoreFailed', error: failureMessage(cause) }) as const,
          }),
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
  Context: (model, host: SearchPanelProps) =>
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
            actionCommand(
              commandHost,
              () => Effect.sync(() => model.props.host.refresh(args)),
              'replace',
            ),
          ]
        : [],
    };
  },
  Open: (model, message: TelegramMessage) => ({
    model,
    commands: [
      actionCommand(
        commandHost,
        () => Effect.sync(() => model.props.host.openResult(message)),
        'replace',
      ),
    ],
  }),
  Close: (model) => ({
    model,
    commands: [
      actionCommand(commandHost, () => Effect.sync(() => model.props.host.close()), 'replace'),
    ],
  }),
});
export type SearchMessage =
  | ActionMessage<typeof searchActions>
  | { type: 'MoreLoaded' }
  | { type: 'MoreFailed'; error: string };

export function createSearchProgram(props: SearchPanelProps) {
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
