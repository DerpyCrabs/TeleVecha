import Search from 'lucide-solid/icons/search';
import X from 'lucide-solid/icons/x';
import { For, Show, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';

import type { TelegramDialog, TelegramMessage, TelegramSearchPage } from '../../telegram/types';
import {
  panelClass,
  panelCloseButtonClass,
  panelErrorClass,
  panelHeaderClass,
  panelLoadMoreClass,
} from '../shared/panelStyles';
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
  const [submitted, setSubmitted] = createSignal(false);
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
    setSubmitted(true);
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
    setSubmitted(false);
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
        <section
          class={`search-panel ${panelClass}`}
          role="dialog"
          aria-modal="true"
          aria-label="Message search"
        >
          <header class={panelHeaderClass}>
            <strong>Search messages</strong>
            <button class={panelCloseButtonClass} onClick={props.close} aria-label="Close search">
              <X size={18} />
            </button>
          </header>
          <div
            class="search-scope flex gap-[0.3rem] px-[0.8rem] pt-[0.6rem]"
            role="group"
            aria-label="Search scope"
          >
            <button
              class="flex items-center gap-[0.35rem] rounded-[0.55rem] border-0 bg-transparent px-[0.7rem] py-[0.45rem] text-muted"
              aria-pressed={!global()}
              classList={{ 'active !bg-[var(--accent-soft)] !text-ink': !global() }}
              onClick={() => changeScope(false)}
            >
              This chat
            </button>
            <button
              class="flex items-center gap-[0.35rem] rounded-[0.55rem] border-0 bg-transparent px-[0.7rem] py-[0.45rem] text-muted"
              aria-pressed={global()}
              classList={{ 'active !bg-[var(--accent-soft)] !text-ink': global() }}
              onClick={() => changeScope(true)}
            >
              All chats
            </button>
          </div>
          <form
            class="mx-[0.8rem] my-[0.7rem] flex items-center gap-[0.55rem] rounded-[0.65rem] border border-[#30343d] bg-[#101216] px-[0.7rem] focus-within:border-[color-mix(in_srgb,var(--accent)_70%,transparent)] focus-within:shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent)_20%,transparent)]"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch(false);
            }}
          >
            <Search size={17} />
            <input
              class="w-full border-0 bg-transparent py-[0.7rem] text-ink outline-0"
              value={query()}
              onInput={(event) => changeQuery(event.currentTarget.value)}
              placeholder={global() ? 'Search all Telegram messages' : 'Search this chat'}
              aria-label="Message search query"
              autofocus
            />
          </form>
          <div class="search-results min-h-40 overflow-y-auto px-[0.8rem] pt-[0.4rem] pb-[0.8rem]">
            <Show
              when={!loading()}
              fallback={<p class="text-[0.78rem] text-muted">Searching Telegram…</p>}
            >
              <For
                each={results()}
                fallback={
                  <Show
                    when={error()}
                    fallback={
                      <p class="text-[0.78rem] text-muted">
                        {query().trim()
                          ? submitted()
                            ? 'No messages found'
                            : 'Press Enter to search'
                          : 'Enter a search term'}
                      </p>
                    }
                  >
                    <div class={`panel-error ${panelErrorClass}`} role="alert">
                      <p>{error()}</p>
                      <button onClick={() => void runSearch(false)}>Retry search</button>
                    </div>
                  </Show>
                }
              >
                {(message) => (
                  <button
                    class="grid w-full gap-[0.2rem] rounded-[0.6rem] border-0 bg-transparent p-[0.65rem] text-left text-ink hover:bg-white/5 [&>span]:text-[0.78rem] [&>span]:text-muted"
                    onClick={() => props.openResult(message)}
                  >
                    <strong>{title(message.peerId)}</strong>
                    <span>{message.text || message.media?.name || 'Message'}</span>
                  </button>
                )}
              </For>
              <Show when={results().length > 0 && error()}>
                <div class={`panel-error ${panelErrorClass}`} role="alert">
                  <p>{error()}</p>
                  <button onClick={() => void runSearch(true)}>Retry loading more</button>
                </div>
              </Show>
              <Show when={hasMore() && !error()}>
                <button
                  class={`panel-load-more ${panelLoadMoreClass}`}
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
