import {
  commandSlot,
  available,
  collection,
  program,
  resourceError,
  actionCommand,
  type Snapshot,
} from 'effectweb';
import {
  defineActions,
  pages,
  type ActionMessage,
  type PagesMessage,
  type PagesModel,
} from 'effectweb/advanced';
import { Effect } from 'effect';
import type { TelegramDialog, TelegramMessage, TelegramSearchPage } from '../../telegram/types';

const commandHost = commandSlot('host');

export interface SearchPanelProps {
  dialogs: readonly TelegramDialog[];
  activePeerId: string;
  search: (
    query: string,
    global: boolean,
    offset?: TelegramSearchPage['nextOffset'],
  ) => Effect.Effect<TelegramSearchPage, unknown>;
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
type Cursor = TelegramSearchPage['nextOffset'];
export type SearchModel = PagesModel<SearchInput, TelegramMessage, Cursor>;
export const searchPage = (model: Snapshot<SearchModel>) => available(model.result);
export const searchError = resourceError;

const pagination = pages<SearchInput, TelegramMessage, Cursor>({
  key: ({ host, submitted, global }) =>
    submitted ? JSON.stringify([submitted, global ? null : host.activePeerId]) : undefined,
  itemKey: messageIdentity,
  load: ({ host, submitted, global }, cursor) =>
    host
      .search(submitted, global, cursor)
      .pipe(
        Effect.map((page) => ({
          items: page.messages,
          next: page.hasMore ? page.nextOffset : undefined,
        })),
      ),
});

const change = (
  model: Snapshot<SearchModel>,
  input: Partial<SearchInput>,
  refresh: boolean = false,
) => pagination.receive(model, { ...model.props, ...input }, { refresh });

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
  | PagesMessage<TelegramMessage, Cursor>;

export function createSearchProgram(props: SearchPanelProps) {
  return program<SearchModel, SearchMessage>({
    initial: pagination.init({ host: props, query: '', global: false, submitted: '' }),
    update: (model, message) =>
      'args' in message ? searchActions.update(model, message) : pagination.update(model, message),
    onDefect: (cause) => console.error('Search command failed', cause),
  });
}
