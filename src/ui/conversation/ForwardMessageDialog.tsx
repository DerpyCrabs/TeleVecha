import { list, component, Portal, view } from 'effectweb';
import type { Snapshot } from 'effectweb';
import { Effect } from 'effect';
import type { ChatSummary } from '../../domain/models';
import type { TelegramPeerSearchResult } from '../../telegram/types';
import { idRows, remotePeerRows } from '../collections';
import Search from '@effectweb/lucide/icons/search';
import X from '@effectweb/lucide/icons/x';
import type { Transition } from 'effectweb';
import { modalMount } from '../shared/modalMount';
const commandSearch = 'search';

interface ForwardMessageDialogProps {
  chats: ChatSummary[];
  close: () => void;
  forward: (peerId: string, result?: TelegramPeerSearchResult) => void;
  search?: ((query: string) => Effect.Effect<TelegramPeerSearchResult[], unknown>) | undefined;
  title?: string | undefined;
  label?: string | undefined;
  cancelLabel?: string | undefined;
}
type ForwardMessageDialogState = {
  query: string;
  remoteResults: TelegramPeerSearchResult[];
  searching: boolean;
};
type ForwardMessageDialogModel = ForwardMessageDialogState & {
  readonly props: ForwardMessageDialogProps;
};
type ForwardMessageDialogMessage =
  | { type: 'Query'; value: string }
  | { type: 'RemoteResults'; value: TelegramPeerSearchResult[] };
function requestSearch(
  model: Snapshot<ForwardMessageDialogModel>,
): Transition<ForwardMessageDialogModel, ForwardMessageDialogMessage> {
  const term = model.query.trim();
  if (!term || !model.props.search)
    return { model: { ...model, remoteResults: [], searching: false }, cancel: [commandSearch] };
  return {
    model: { ...model, remoteResults: [], searching: true },
    commands: [
      {
        key: commandSearch,
        policy: 'replace',
        effect: Effect.sleep(180).pipe(
          Effect.andThen(Effect.suspend(() => model.props.search!(term))),
          Effect.matchCause({
            onSuccess: (value) => ({ type: 'RemoteResults', value }) as const,
            onFailure: () => ({ type: 'RemoteResults', value: [] }) as const,
          }),
        ),
      },
    ],
  };
}
export const ForwardMessageDialog = component<
  ForwardMessageDialogProps,
  ForwardMessageDialogState,
  ForwardMessageDialogMessage
>(
  {
    init: () => ({ query: '', remoteResults: [], searching: false }),
    update: (model, message) => {
      switch (message.type) {
        case 'Query':
          return requestSearch({ ...model, query: message.value });
        case 'RemoteResults':
          return { model: { ...model, remoteResults: message.value, searching: false } };
      }
    },
  },
  view((model, send) => {
    const props = model.props;
    const localChats = (() => {
      const term = model.query.trim().toLocaleLowerCase();
      return term
        ? props.chats.filter((chat) =>
            `${chat.title} ${chat.username ?? ''}`.toLocaleLowerCase().includes(term),
          )
        : props.chats;
    })();
    const newRemoteResults = (() => {
      const localIds = new Set(props.chats.map(({ id }) => id));
      return model.remoteResults.filter(({ peer }) => !localIds.has(peer.id));
    })();
    return (
      <Portal>
        <div
          use={modalMount(props.close)}
          class="forward-overlay"
          role="presentation"
          tabIndex={-1}
          onPointerDown={(event) => event.target === event.currentTarget && props.close()}
        >
          <div
            class="forward-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={props.label ?? 'Forward message'}
          >
            <header>
              <strong>{props.title ?? 'Forward to'}</strong>
              <button onClick={props.close} aria-label={props.cancelLabel ?? 'Cancel forward'}>
                <X size={17} />
              </button>
            </header>
            {props.search ? (
              <label class="mx-3 my-2 flex items-center gap-2 rounded-lg border border-line bg-black/10 px-3 py-2 text-muted">
                <Search size={16} />
                <input
                  class="min-w-0 flex-1 border-0 bg-transparent text-ink outline-none"
                  value={model.query}
                  onInput={(event) => send({ type: 'Query', value: event.currentTarget.value })}
                  placeholder="Search chats"
                  aria-label="Search chats to forward"
                />
              </label>
            ) : null}
            <div>
              {list(idRows(localChats), (chat) => (
                <button onClick={() => props.forward(chat.id)}>{chat.title}</button>
              ))}
              {list(remotePeerRows(newRemoteResults), (result) => (
                <button onClick={() => props.forward(result.peer.id, result)}>
                  {result.title}
                  {result.username ? <small>@{result.username}</small> : null}
                </button>
              ))}
              {Boolean(model.query.trim()) && model.searching ? (
                <p class="px-3 py-2 text-xs text-muted">Searching chats…</p>
              ) : null}
              {!model.searching &&
              Boolean(model.query.trim()) &&
              localChats.length === 0 &&
              newRemoteResults.length === 0 ? (
                <p class="px-3 py-2 text-xs text-muted">No chats found</p>
              ) : null}
            </div>
          </div>
        </div>
      </Portal>
    );
  }),
);
