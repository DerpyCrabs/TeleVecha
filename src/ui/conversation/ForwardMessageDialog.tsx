import X from 'lucide-solid/icons/x';
import Search from 'lucide-solid/icons/search';
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';

import type { ChatSummary } from '../../domain/models';
import type { TelegramPeerSearchResult } from '../../telegram/types';
import { useModalDialog } from '../shared/useModalDialog';

export function ForwardMessageDialog(props: {
  chats: ChatSummary[];
  close: () => void;
  forward: (peerId: string, result?: TelegramPeerSearchResult) => void;
  search?: ((query: string) => Promise<TelegramPeerSearchResult[]>) | undefined;
  title?: string | undefined;
  label?: string | undefined;
  cancelLabel?: string | undefined;
}) {
  let overlay: HTMLDivElement | undefined;
  useModalDialog(() => overlay, props.close);
  const [query, setQuery] = createSignal('');
  const [remoteResults, setRemoteResults] = createSignal<TelegramPeerSearchResult[]>([]);
  const [searching, setSearching] = createSignal(false);
  let searchVersion = 0;

  createEffect(() => {
    const term = query().trim();
    const version = ++searchVersion;
    if (!term || !props.search) {
      setRemoteResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void props.search!(term)
        .then((results) => {
          if (version === searchVersion) setRemoteResults(results);
        })
        .catch(() => {
          if (version === searchVersion) setRemoteResults([]);
        })
        .finally(() => {
          if (version === searchVersion) setSearching(false);
        });
    }, 180);
    onCleanup(() => window.clearTimeout(timer));
  });

  const localChats = createMemo(() => {
    const term = query().trim().toLocaleLowerCase();
    return term
      ? props.chats.filter((chat) =>
          `${chat.title} ${chat.username ?? ''}`.toLocaleLowerCase().includes(term),
        )
      : props.chats;
  });
  const newRemoteResults = createMemo(() => {
    const localIds = new Set(props.chats.map(({ id }) => id));
    return remoteResults().filter(({ peer }) => !localIds.has(peer.id));
  });

  return (
    <Portal>
      <div
        ref={(element) => (overlay = element)}
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
          <Show when={props.search}>
            <label class="mx-3 my-2 flex items-center gap-2 rounded-lg border border-line bg-black/10 px-3 py-2 text-muted">
              <Search size={16} />
              <input
                class="min-w-0 flex-1 border-0 bg-transparent text-ink outline-none"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search chats"
                aria-label="Search chats to forward"
              />
            </label>
          </Show>
          <div>
            <For each={localChats()}>
              {(chat) => <button onClick={() => props.forward(chat.id)}>{chat.title}</button>}
            </For>
            <For each={newRemoteResults()}>
              {(result) => (
                <button onClick={() => props.forward(result.peer.id, result)}>
                  {result.title}
                  <Show when={result.username}>
                    <small>@{result.username}</small>
                  </Show>
                </button>
              )}
            </For>
            <Show when={Boolean(query().trim()) && searching()}>
              <p class="px-3 py-2 text-xs text-muted">Searching chats…</p>
            </Show>
            <Show
              when={
                !searching() &&
                Boolean(query().trim()) &&
                localChats().length === 0 &&
                newRemoteResults().length === 0
              }
            >
              <p class="px-3 py-2 text-xs text-muted">No chats found</p>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
