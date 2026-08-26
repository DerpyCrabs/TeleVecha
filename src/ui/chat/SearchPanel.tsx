import Search from 'lucide-solid/icons/search';
import X from 'lucide-solid/icons/x';
import { For, Show, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';

import type { TelegramDialog, TelegramMessage, TelegramSearchPage } from '../../telegram/types';
import { useModalDialog } from '../shared/useModalDialog';

interface SearchPanelProps {
  dialogs: TelegramDialog[];
  activePeerId: string;
  search: (
    query: string,
    global: boolean,
    offset?: TelegramSearchPage['nextOffset'],
  ) => Promise<TelegramSearchPage>;
  openResult: (message: TelegramMessage) => void;
  close: () => void;
}

export function SearchPanel(props: SearchPanelProps) {
  const [query, setQuery] = createSignal('');
  const [global, setGlobal] = createSignal(false);
  const [results, setResults] = createSignal<TelegramMessage[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [hasMore, setHasMore] = createSignal(false);
  const [nextOffset, setNextOffset] = createSignal<TelegramSearchPage['nextOffset']>();
  const [error, setError] = createSignal('');
  let overlay: HTMLDivElement | undefined;
  let searchVersion = 0;
  useModalDialog(() => overlay, props.close);

  const runSearch = async (append = false, scope = global()) => {
    const term = query().trim();
    if (!term) {
      setResults([]);
      setHasMore(false);
      setNextOffset(undefined);
      setError('');
      return;
    }
    const version = ++searchVersion;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError('');
    try {
      const page = await props.search(term, scope, append ? nextOffset() : undefined);
      if (version === searchVersion) {
        setResults((current) => {
          if (!append) return page.messages;
          const known = new Set(current.map(({ peerId, id }) => `${peerId}:${id}`));
          return [
            ...current,
            ...page.messages.filter(({ peerId, id }) => !known.has(`${peerId}:${id}`)),
          ];
        });
        setNextOffset(page.nextOffset);
        setHasMore(page.hasMore && Boolean(page.nextOffset));
      }
    } catch (cause) {
      if (version === searchVersion) {
        setError(cause instanceof Error ? cause.message : String(cause));
        if (!append) setResults([]);
      }
    } finally {
      if (version === searchVersion) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  const changeScope = (nextGlobal: boolean) => {
    if (nextGlobal === global()) return;
    setGlobal(nextGlobal);
    if (query().trim()) void runSearch(false, nextGlobal);
  };

  const changeQuery = (value: string) => {
    searchVersion += 1;
    setQuery(value);
    setResults([]);
    setHasMore(false);
    setNextOffset(undefined);
    setError('');
    setLoading(false);
    setLoadingMore(false);
  };

  const title = (peerId: string) =>
    props.dialogs.find(({ peer }) => peer.id === peerId)?.title ?? peerId;

  return (
    <Portal>
      <div
        ref={(element) => (overlay = element)}
        class="panel-overlay"
        role="presentation"
        tabIndex={-1}
        onPointerDown={(event) => event.target === event.currentTarget && props.close()}
      >
        <section class="search-panel" role="dialog" aria-modal="true" aria-label="Message search">
          <header>
            <strong>Search messages</strong>
            <button onClick={props.close} aria-label="Close search">
              <X size={18} />
            </button>
          </header>
          <div class="search-scope" role="group" aria-label="Search scope">
            <button
              aria-pressed={!global()}
              classList={{ active: !global() }}
              onClick={() => changeScope(false)}
            >
              This chat
            </button>
            <button
              aria-pressed={global()}
              classList={{ active: global() }}
              onClick={() => changeScope(true)}
            >
              All chats
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch(false);
            }}
          >
            <Search size={17} />
            <input
              value={query()}
              onInput={(event) => changeQuery(event.currentTarget.value)}
              placeholder={global() ? 'Search all Telegram messages' : 'Search this chat'}
              aria-label="Message search query"
              autofocus
            />
          </form>
          <div class="search-results">
            <Show when={!loading()} fallback={<p>Searching Telegram…</p>}>
              <For
                each={results()}
                fallback={
                  <Show
                    when={error()}
                    fallback={<p>{query().trim() ? 'No messages found' : 'Enter a search term'}</p>}
                  >
                    <div class="panel-error" role="alert">
                      <p>{error()}</p>
                      <button onClick={() => void runSearch(false)}>Retry search</button>
                    </div>
                  </Show>
                }
              >
                {(message) => (
                  <button onClick={() => props.openResult(message)}>
                    <strong>{title(message.peerId)}</strong>
                    <span>{message.text || message.media?.name || 'Message'}</span>
                  </button>
                )}
              </For>
              <Show when={results().length > 0 && error()}>
                <div class="panel-error" role="alert">
                  <p>{error()}</p>
                  <button onClick={() => void runSearch(true)}>Retry loading more</button>
                </div>
              </Show>
              <Show when={hasMore() && !error()}>
                <button
                  class="panel-load-more"
                  disabled={loadingMore()}
                  onClick={() => void runSearch(true)}
                >
                  {loadingMore() ? 'Loading more…' : 'Load more'}
                </button>
              </Show>
            </Show>
          </div>
        </section>
      </div>
    </Portal>
  );
}
