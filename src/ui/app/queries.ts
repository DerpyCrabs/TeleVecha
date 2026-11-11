import type { TelegramSearchFilters } from '../../telegram/types';
import { Context, Effect } from 'effect';
import {
  fetchNextPage,
  infiniteQuery,
  query,
  querySource,
  type QueryCache,
} from '@effectweb/query';
import type {
  SharedMediaKind,
  TelegramMessage,
  TelegramReadReceipts,
  TelegramReactionPeople,
  TelegramSearchOffset,
  TelegramSearchPage,
} from '../../telegram/types';

export interface CustomEmojiAsset {
  readonly url: string;
  readonly mimeType: string;
}

/** Reads that views observe through the query cache. The app controller implements them. */
export interface QueryLoaders {
  readReceipts(peerId: string, messageId: number): Effect.Effect<TelegramReadReceipts, unknown>;
  reactionPeople(
    peerId: string,
    messageId: number,
    emoji: string,
  ): Effect.Effect<TelegramReactionPeople, unknown>;
  customEmoji(documentId: string): Effect.Effect<CustomEmojiAsset, unknown>;
  previewPhoto(peerId: string, messageId: string): Effect.Effect<string, unknown>;
  searchMessages(
    peerId: string,
    text: string,
    global: boolean,
    offset: TelegramSearchOffset | undefined,
    filters?: TelegramSearchFilters,
  ): Effect.Effect<TelegramSearchPage, unknown>;
  sharedMedia(
    peerId: string,
    kind: SharedMediaKind,
    offset: TelegramSearchOffset | undefined,
  ): Effect.Effect<TelegramSearchPage, unknown>;
}
export const QueryLoaders = Context.Service<QueryLoaders>('ui/QueryLoaders');

// Detail popovers show a placeholder rather than an error when optional media is unavailable.
const optional = <A>(load: Effect.Effect<A, unknown>) =>
  load.pipe(Effect.catch(() => Effect.succeed(undefined)));

export const readReceiptsQuery = query({
  name: 'message-read-receipts',
  staleTime: 60_000,
  load: (args: { peerId: string; messageId: number; revision: string }) =>
    Effect.flatMap(QueryLoaders, (loaders) => loaders.readReceipts(args.peerId, args.messageId)),
});
export const reactionPeopleQuery = query({
  name: 'reaction-people',
  // `revision` is part of identity only: a changed reaction count loads the list again.
  load: (args: { peerId: string; messageId: number; emoji: string; revision: string }) =>
    Effect.flatMap(QueryLoaders, (loaders) =>
      optional(loaders.reactionPeople(args.peerId, args.messageId, args.emoji)),
    ),
});
export const customEmojiQuery = query({
  name: 'custom-emoji',
  load: (documentId: string) =>
    Effect.flatMap(QueryLoaders, (loaders) => optional(loaders.customEmoji(documentId))),
});
export const previewPhotoQuery = query({
  name: 'link-preview-photo',
  load: (args: { peerId: string; messageId: string }) =>
    Effect.flatMap(QueryLoaders, (loaders) =>
      optional(loaders.previewPhoto(args.peerId, args.messageId)),
    ),
});

export type SearchCursor = { readonly offset?: TelegramSearchOffset | undefined };
const nextCursor = (page: { readonly hasMore: boolean; readonly nextOffset?: unknown }) =>
  page.hasMore ? { offset: page.nextOffset as TelegramSearchOffset | undefined } : undefined;

export interface MessageSearchArgs {
  /** The searched chat, or empty for a global search. */
  readonly peerId: string;
  readonly text: string;
  readonly global: boolean;
  readonly filters?: TelegramSearchFilters;
}
export const messageSearchQuery = infiniteQuery({
  name: 'message-search',
  initial: {} as SearchCursor,
  load: (args: MessageSearchArgs, cursor: SearchCursor) =>
    Effect.flatMap(QueryLoaders, (loaders) =>
      loaders.searchMessages(args.peerId, args.text, args.global, cursor.offset, args.filters),
    ),
  next: nextCursor,
});
export const sharedMediaQuery = infiniteQuery({
  name: 'shared-media',
  initial: {} as SearchCursor,
  load: (args: { peerId: string; kind: SharedMediaKind }, cursor: SearchCursor) =>
    Effect.flatMap(QueryLoaders, (loaders) =>
      loaders.sharedMedia(args.peerId, args.kind, cursor.offset),
    ),
  next: nextCursor,
});

/** Messages of loaded search pages in order; a message repeated by a later page appears once. */
export function pageMessages(
  pages: readonly { readonly value: { readonly messages: readonly TelegramMessage[] } }[],
) {
  const seen = new Set<string>();
  return pages
    .flatMap((page) => page.value.messages)
    .filter((message) => {
      const key = `${message.peerId}:${message.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** View-facing sources and page actions over one cache. Equal arguments share one source. */
export function querySources(cache: QueryCache<QueryLoaders>) {
  return {
    readReceipts: (peerId: string, messageId: number, revision: string) =>
      querySource(cache, readReceiptsQuery, { peerId, messageId, revision }),
    reactionPeople: (peerId: string, messageId: number, emoji: string, revision: string) =>
      querySource(cache, reactionPeopleQuery, { peerId, messageId, emoji, revision }),
    customEmoji: (documentId: string) => querySource(cache, customEmojiQuery, documentId),
    previewPhoto: (peerId: string, messageId: string) =>
      querySource(cache, previewPhotoQuery, { peerId, messageId }),
    messageSearch: (args: MessageSearchArgs) => querySource(cache, messageSearchQuery, args),
    moreMessages: (args: MessageSearchArgs) => fetchNextPage(cache, messageSearchQuery, args),
    refreshMessages: (args: MessageSearchArgs) =>
      cache.invalidateQuery(messageSearchQuery.query, args),
    sharedMedia: (peerId: string, kind: SharedMediaKind) =>
      querySource(cache, sharedMediaQuery, { peerId, kind }),
    moreMedia: (peerId: string, kind: SharedMediaKind) =>
      fetchNextPage(cache, sharedMediaQuery, { peerId, kind }),
    refreshMedia: (peerId: string, kind: SharedMediaKind) =>
      cache.invalidateQuery(sharedMediaQuery.query, { peerId, kind }),
  };
}
export type QuerySources = ReturnType<typeof querySources>;
