import { Effect } from 'effect';
import { createUiPages } from '../reactivity/solid';
import { loadEffect, type UiLoad } from '../reactivity/model';
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
  ) => UiLoad<TelegramSearchPage>;
  openResult: (message: TelegramMessage) => void;
  close: () => void;
}

export function SearchPanel(props: SearchPanelProps) {
  const [query, setQuery] = createSignal('');
  const [global, setGlobal] = createSignal(false);
  const [submittedQuery, setSubmittedQuery] = createSignal('');
  const submitted = () => Boolean(submittedQuery());
  let overlay: HTMLDivElement | undefined;
  useModalDialog(() => overlay, props.close);
  const pages = createUiPages(
    () =>
      submittedQuery()
        ? { term: submittedQuery(), global: global(), peerId: props.activePeerId }
        : false,
    (request, offset: TelegramSearchPage['nextOffset']) =>
      loadEffect(() => props.search(request.term, request.global, offset)).pipe(
        Effect.map((page) => ({
          items: page.messages,
          next: page.hasMore ? page.nextOffset : undefined,
        })),
      ),
    {
      key: (request) => JSON.stringify(request),
      itemKey: (message) => `${message.peerId}:${message.id}`,
    },
  );
  const { items: results, loading, loadingMore, hasMore, error } = pages;
  const runSearch = (append = false) => {
    if (append) return pages.more();
    const term = query().trim();
    if (submittedQuery() === term) pages.refresh();
    else setSubmittedQuery(term);
  };
  const changeScope = (nextGlobal: boolean) => {
    setGlobal(nextGlobal);
    setSubmittedQuery(query().trim());
  };
  const changeQuery = (value: string) => {
    setSubmittedQuery('');
    setQuery(value);
  };

  const title = (message: TelegramMessage) =>
    props.dialogs.find(({ peer }) => peer.id === message.peerId)?.title ??
    message.peerTitle ??
    message.peerId;

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
              runSearch(false);
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
                      <button onClick={() => runSearch(false)}>Retry search</button>
                    </div>
                  </Show>
                }
              >
                {(message) => (
                  <button
                    class="grid w-full gap-[0.2rem] rounded-[0.6rem] border-0 bg-transparent p-[0.65rem] text-left text-ink hover:bg-white/5 [&>span]:text-[0.78rem] [&>span]:text-muted"
                    onClick={() => props.openResult(message)}
                  >
                    <strong>{title(message)}</strong>
                    <span>{message.text || message.media?.name || 'Message'}</span>
                  </button>
                )}
              </For>
              <Show when={results().length > 0 && error()}>
                <div class={`panel-error ${panelErrorClass}`} role="alert">
                  <p>{error()}</p>
                  <button onClick={() => runSearch(true)}>Retry loading more</button>
                </div>
              </Show>
              <Show when={hasMore() && !error()}>
                <button
                  class={`panel-load-more ${panelLoadMoreClass}`}
                  disabled={loadingMore()}
                  onClick={() => runSearch(true)}
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
