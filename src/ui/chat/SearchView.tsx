import { list } from 'effectweb';
import { available, observe, submit, view } from 'effectweb';
import { Dialog } from '../shared/Dialog';
import { panelClass, panelErrorClass, panelLoadMoreClass } from '../shared/panelStyles';
import {
  searchActions,
  searchArgs,
  searchError,
  searchMessages,
  searchRows,
  type SearchMessage,
  type SearchModel,
  type SearchResults,
} from './searchProgram';
import * as AsyncResult from 'effect/reactivity/AsyncResult';

const notSubmitted: SearchResults = AsyncResult.initial();

export const SearchView = view<SearchModel, SearchMessage>((model, send) => {
  const dispatch = searchActions.bind(send);
  const { query, global, submitted, host } = model.props;
  const args = searchArgs(model.props);
  const title = (peerId: string) => host.dialogs.find(({ peer }) => peer.id === peerId)?.title;
  const results = (result: SearchResults) => {
    const page = available(result);
    const rows = searchMessages.from(searchRows(result));
    const error = model.moreError || searchError(result);
    const loading = result.waiting && !page;
    return loading ? (
      <p class="text-[0.78rem] text-muted">Searching Telegram…</p>
    ) : (
      <>
        {list(rows, (message) => (
          <button
            class="grid w-full gap-[0.2rem] rounded-[0.6rem] border-0 bg-transparent p-[0.65rem] text-left text-ink hover:bg-white/5 [&>span]:text-[0.78rem] [&>span]:text-muted"
            onClick={() => dispatch.Open(message)}
          >
            <strong>{title(message.peerId) ?? message.peerTitle ?? message.peerId}</strong>
            <span>{message.text || message.media?.name || 'Message'}</span>
          </button>
        ))}
        {error ? (
          <div class={`panel-error ${panelErrorClass}`} role="alert">
            <p>{error}</p>
            <button onClick={dispatch.Retry}>
              {model.moreError ? 'Retry loading more' : 'Retry search'}
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p class="text-[0.78rem] text-muted">
            {query.trim()
              ? submitted
                ? 'No messages found'
                : 'Press Enter to search'
              : 'Enter a search term'}
          </p>
        ) : null}
        {page?.next !== undefined && !error ? (
          <button
            class={`panel-load-more ${panelLoadMoreClass}`}
            disabled={model.loadingMore}
            onClick={dispatch.More}
          >
            {model.loadingMore ? 'Loading more…' : 'Load more'}
          </button>
        ) : null}
      </>
    );
  };
  return (
    <Dialog
      title="Search messages"
      label="Message search"
      onClose={dispatch.Close}
      closeLabel="Close search"
      class={`search-panel ${panelClass}`}
    >
      <div
        class="search-scope flex gap-[0.3rem] px-[0.8rem] pt-[0.6rem]"
        role="group"
        aria-label="Search scope"
      >
        <button
          class="flex items-center gap-[0.35rem] rounded-[0.55rem] border-0 bg-transparent px-[0.7rem] py-[0.45rem] text-muted"
          aria-pressed={!global}
          classList={{ 'active !bg-[var(--accent-soft)] !text-ink': !global }}
          onClick={() => dispatch.Scope(false)}
        >
          This chat
        </button>
        <button
          class="flex items-center gap-[0.35rem] rounded-[0.55rem] border-0 bg-transparent px-[0.7rem] py-[0.45rem] text-muted"
          aria-pressed={global}
          classList={{ 'active !bg-[var(--accent-soft)] !text-ink': global }}
          onClick={() => dispatch.Scope(true)}
        >
          All chats
        </button>
      </div>
      <form
        class="mx-[0.8rem] my-[0.7rem] flex items-center gap-[0.55rem] rounded-[0.65rem] border border-[#30343d] bg-[#101216] px-[0.7rem] focus-within:border-[color-mix(in_srgb,var(--accent)_70%,transparent)] focus-within:shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent)_20%,transparent)]"
        onSubmit={submit(dispatch.Submit)}
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          class="w-full border-0 bg-transparent py-[0.7rem] text-ink outline-0"
          value={query}
          onInput={(event) => dispatch.Query(event.currentTarget.value)}
          placeholder={global ? 'Search all Telegram messages' : 'Search this chat'}
          aria-label="Message search query"
          autofocus
        />
      </form>
      <div class="search-results min-h-40 overflow-y-auto px-[0.8rem] pt-[0.4rem] pb-[0.8rem]">
        {args ? observe(host.results(args), results) : results(notSubmitted)}
      </div>
    </Dialog>
  );
});
