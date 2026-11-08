import { SavedTagFilters } from '../saved/SavedTagFilters';
import './search.css';
import { Avatar } from '../shared/Avatar';
import { SearchSenderFilter } from './SearchSenderFilter';
import type { SharedMediaKind, TelegramSearchFilters, TelegramPeer } from '../../telegram/types';
import { list } from 'effectweb';
import { available, observe, view, type Send } from 'effectweb';
import ArrowLeft from '@effectweb/lucide/icons/arrow-left';
import Calendar from '@effectweb/lucide/icons/calendar-days';
import X from '@effectweb/lucide/icons/x';
import { searchPanelMount } from './searchPanelMount';
import { panelErrorClass, panelLoadMoreClass } from '../shared/panelStyles';
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

const kinds: readonly [string, string][] = [
  ['', 'All messages'],
  ['photos', 'Photos'],
  ['videos', 'Videos'],
  ['files', 'Files'],
  ['audio', 'Music'],
  ['voice', 'Voice messages'],
  ['links', 'Links'],
  ['gifs', 'GIFs'],
];
const notSubmitted: SearchResults = AsyncResult.initial();

export const SearchView = view<{ model: SearchModel; send: Send<SearchMessage> }>(
  ({ model, send }) => {
    const dispatch = searchActions.bind(send);
    const { query, global, host, filters, fromDate, untilDate, dateError } = model.props;
    const args = searchArgs(model.props);
    const dialog = (peerId: string) => host.dialogs.find(({ peer }) => peer.id === peerId);
    const results = (result: SearchResults) => {
      const page = available(result);
      const rows = searchMessages.from(searchRows(result));
      const error = model.moreError || searchError(result);
      const loading = result.waiting && !page;
      return loading ? (
        <p class="text-[0.78rem] text-muted">Searching Telegram…</p>
      ) : (
        <>
          {list(rows, (message) => {
            const chat = dialog(message.peerId);
            const title = chat?.title ?? message.peerTitle ?? message.peerId;
            const sender = dialog(message.senderId);
            const senderTitle = message.outgoing
              ? 'You'
              : (message.senderName ?? sender?.title ?? title);
            const rowTitle = global ? title : senderTitle;
            const senderPeer: TelegramPeer = sender?.peer ?? {
              id: message.senderId,
              kind: message.senderId.startsWith('c:')
                ? 'channel'
                : message.senderId.startsWith('g:')
                  ? 'group'
                  : 'user',
            };
            const useSender = !global && Boolean(message.senderId);
            const date = new Date(message.date * 1000);
            return (
              <button
                class="search-result"
                onClick={() => dispatch.Open(message)}
                title={`Open message in ${title}`}
              >
                <Avatar
                  identity={`search:${useSender ? message.senderId : message.peerId}:${useSender ? (message.senderAvatarId ?? '') : (chat?.avatarId ?? '')}`}
                  size="sm"
                  initials={
                    useSender
                      ? senderTitle
                          .split(/\s+/)
                          .slice(0, 2)
                          .map((part) => part[0])
                          .join('')
                      : (chat?.initials ?? title.slice(0, 2))
                  }
                  color={
                    useSender
                      ? (message.senderColor ?? sender?.color ?? 'var(--accent)')
                      : (chat?.color ?? 'var(--accent)')
                  }
                  loadCached={
                    host.media
                      ? () =>
                          useSender
                            ? host.media!.loadPeerAvatar(
                                senderPeer,
                                true,
                                message.senderAvatarId,
                                true,
                              )
                            : host.media!.loadAvatar(message.peerId, true)
                      : undefined
                  }
                  load={
                    host.media && host.online
                      ? () =>
                          useSender
                            ? host.media!.loadPeerAvatar(senderPeer, true, message.senderAvatarId)
                            : host.media!.loadAvatar(message.peerId)
                      : undefined
                  }
                />
                <span class="search-result-content">
                  <span class="search-result-heading">
                    <strong>{rowTitle}</strong>
                    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
                      {date.toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </time>
                  </span>
                  {global && message.senderName ? (
                    <span class="search-result-sender">{message.senderName}</span>
                  ) : null}
                  <span class="search-result-text">
                    {message.text ||
                      message.poll?.question ||
                      message.contact?.firstName ||
                      message.media?.name ||
                      'Message'}
                  </span>
                </span>
              </button>
            );
          })}
          {error ? (
            <div class={`panel-error ${panelErrorClass}`} role="alert">
              <p>{error}</p>
              <button onClick={dispatch.Retry}>
                {model.moreError ? 'Retry loading more' : 'Retry search'}
              </button>
            </div>
          ) : rows.length === 0 ? (
            <p class="text-[0.78rem] text-muted">
              {args
                ? 'No messages found'
                : query.trim()
                  ? 'Searching…'
                  : 'Enter a search term or choose a filter'}
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
      <aside
        class="search-panel"
        role={host.compact ? 'dialog' : 'complementary'}
        aria-modal={host.compact || undefined}
        aria-label="Message search"
        use={searchPanelMount({ compact: host.compact ?? false, close: dispatch.Close })}
      >
        <header class="search-panel-header">
          <button
            type="button"
            class="search-back"
            title="Back to chats"
            aria-label="Close search"
            onClick={dispatch.Close}
          >
            <ArrowLeft size={22} />
          </button>
          <form
            class="search-query"
            onSubmit={(event) => {
              event.preventDefault();
              dispatch.Submit();
            }}
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
              type="search"
              class="w-full border-0 bg-transparent py-[0.7rem] text-ink outline-0"
              value={query}
              onInput={(event) => dispatch.Query(event.currentTarget.value)}
              placeholder={global ? 'Search all Telegram messages' : 'Search this chat'}
              aria-label="Message search query"
              autofocus
            />
          </form>
        </header>
        {!global && host.savedTags ? (
          <SavedTagFilters
            customEmoji={host.savedTags.customEmoji}
            api={host.savedTags.api}
            selfId={host.savedTags.selfId}
            source={host.activeSavedPeer}
            premium={host.savedTags.premium}
            online={host.online ?? false}
            selected={filters.savedReactions ?? []}
            change={(selected) =>
              dispatch.Filters({
                ...filters,
                savedReactions: selected.length ? selected : undefined,
              })
            }
          />
        ) : null}
        <div class="search-context">
          <button
            type="button"
            class="search-scope-chip"
            title={global ? 'Search this chat' : 'Search all chats'}
            onClick={() => dispatch.Scope(!global)}
          >
            {global
              ? 'All chats'
              : `In: ${host.activeSavedTitle ?? host.activeTopicTitle ?? dialog(host.activePeerId)?.title ?? 'this chat'}`}
            {!global ? <X size={14} /> : null}
          </button>
          {!global ? (
            <SearchSenderFilter
              host={host}
              selected={filters.fromPeer}
              change={(fromPeer) => dispatch.Filters({ ...filters, fromPeer })}
            />
          ) : (
            <select
              class="search-chat-type"
              aria-label="Chat type"
              value={filters.chatType ?? ''}
              onChange={(event) =>
                dispatch.Filters({
                  ...filters,
                  chatType: (event.currentTarget.value ||
                    undefined) as TelegramSearchFilters['chatType'],
                })
              }
            >
              <option value="">All types</option>
              <option value="users">People</option>
              <option value="groups">Groups</option>
              <option value="channels">Channels</option>
            </select>
          )}
          <details class="search-date-picker">
            <summary title="Filter by date" aria-label="Filter by date">
              <Calendar size={17} />
              {fromDate || untilDate ? 'Dates set' : 'Date'}
            </summary>
            <div class="search-date-fields">
              <label>
                From
                <input
                  type="date"
                  aria-label="From date"
                  value={fromDate}
                  max={untilDate || undefined}
                  onChange={(event) => dispatch.Dates(event.currentTarget.value, untilDate)}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  aria-label="To date"
                  value={untilDate}
                  min={fromDate || undefined}
                  onChange={(event) => dispatch.Dates(fromDate, event.currentTarget.value)}
                />
              </label>
              {fromDate || untilDate ? (
                <button type="button" onClick={() => dispatch.Dates('', '')}>
                  Clear dates
                </button>
              ) : null}
            </div>
          </details>
          {Object.values(filters).some((value) => value !== undefined) || fromDate || untilDate ? (
            <button
              type="button"
              class="search-clear-filters"
              title="Clear filters"
              aria-label="Clear filters"
              onClick={dispatch.ClearFilters}
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
        <div class="search-kind-tabs" role="group" aria-label="Message type">
          {list(
            kinds,
            ([value]) => value,
            ([value, label]) => (
              <button
                type="button"
                aria-pressed={(filters.kind ?? '') === value}
                onClick={() =>
                  dispatch.Filters({
                    ...filters,
                    kind: (value || undefined) as SharedMediaKind | undefined,
                  })
                }
              >
                {value ? label : 'Messages'}
              </button>
            ),
          )}
        </div>
        {dateError ? (
          <p class="search-date-error" role="alert">
            {dateError}
          </p>
        ) : null}
        <div class="search-results min-h-40 overflow-y-auto px-[0.8rem] pt-[0.4rem] pb-[0.8rem]">
          {args ? observe(host.results(args), results) : results(notSubmitted)}
        </div>
      </aside>
    );
  },
);
