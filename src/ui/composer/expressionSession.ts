import { Context, Effect } from 'effect';
import { modelOwner, available, program, resourceError } from 'effectweb';
import type { SessionContext } from '../app/sessionContext';
import type { EffectConversation } from '../../telegram/core/conversation';
import type { MessagingError } from '../../telegram/core/messagingError';
import type {
  TelegramPeer,
  TelegramReplyTarget,
  TelegramResourceInvalidation,
  TelegramSticker,
  TelegramStickerSearchPage,
  TelegramStickerPack,
} from '../../telegram/types';
import type { UiEffectRunner, UiTaskRunner } from '../app/appRuntime';
import { subscribeAtUi } from '../app/appRuntime';
import { fetchNextPage, infiniteQuery, observeQuery, query, querySource } from '@effectweb/query';
export interface ExpressionSource {
  searchStickers?(
    query: string,
    offset?: number,
  ): Effect.Effect<TelegramStickerSearchPage, MessagingError>;
  getRecentStickers(): Effect.Effect<TelegramSticker[], MessagingError>;
  getFavoriteStickers?(): Effect.Effect<TelegramSticker[], MessagingError>;
  setStickerFavorite?(
    sticker: TelegramSticker,
    favorite: boolean,
  ): Effect.Effect<void, MessagingError>;
  getStickerPacks(): Effect.Effect<TelegramStickerPack[], MessagingError>;
  getStickerPack?(shortName: string): Effect.Effect<TelegramStickerPack, MessagingError>;
  searchStickerPacks?(query: string): Effect.Effect<TelegramStickerPack[], MessagingError>;
  setStickerPackInstalled?(
    pack: TelegramStickerPack,
    installed: boolean,
  ): Effect.Effect<void, MessagingError>;
  getSavedGifs(): Effect.Effect<TelegramSticker[], MessagingError>;
  searchGifs(peer: TelegramPeer, query: string): Effect.Effect<TelegramSticker[], MessagingError>;
  subscribeResources(
    listener: (event: TelegramResourceInvalidation) => void,
  ): Effect.Effect<Effect.Effect<void>, MessagingError>;
}

export const ExpressionSource = Context.Service<ExpressionSource>('ui/ExpressionSource');

// Catalogs have no entity parameters. Their source supplies operations, while the cache owns
// account identity; recreating a session or its callbacks does not create another catalog.
export const stickerCatalog = query({
  name: 'expressions:stickers',
  load: () =>
    Effect.flatMap(ExpressionSource, (source) =>
      Effect.all(
        [
          source.getRecentStickers(),
          source.getStickerPacks(),
          source.getFavoriteStickers?.() ?? Effect.succeed([]),
        ],
        { concurrency: 'unbounded' },
      ).pipe(
        Effect.map(([recent, installed, favorites]) => [
          { id: 'favorites', title: 'Favorites', stickers: favorites },
          ...(recent.length ? [{ id: 'recent', title: 'Recent', stickers: recent }] : []),
          ...installed,
        ]),
      ),
    ),
});
export const gifCatalog = query({
  name: 'expressions:gifs',
  load: () => Effect.flatMap(ExpressionSource, (source) => source.getSavedGifs()),
});

// Typing selects a new query; the unobserved search is cancelled before its debounce ends.
export const gifSearch = query({
  name: 'expressions:gif-search',
  unused: 'cancel',
  load: (args: { peer: TelegramPeer; text: string }) =>
    Effect.sleep(250).pipe(
      Effect.andThen(
        Effect.flatMap(ExpressionSource, (source) => source.searchGifs(args.peer, args.text)),
      ),
    ),
});

export const stickerSearch = infiniteQuery({
  name: 'expressions:sticker-search',
  unused: 'cancel',
  initial: 0,
  load: (text: string, offset: number) =>
    (offset === 0 ? Effect.sleep(250) : Effect.void).pipe(
      Effect.andThen(
        Effect.flatMap(
          ExpressionSource,
          (source) =>
            source.searchStickers?.(text, offset) ??
            Effect.succeed({ stickers: [] } as TelegramStickerSearchPage),
        ),
      ),
    ),
  next: (page) => page.nextOffset,
});

/** Owns expression catalogs, picker exclusivity, invalidation, and sends. */
export function createExpressionSession(
  options: {
    source: ExpressionSource;
    runEffect: UiEffectRunner;
    runTask: UiTaskRunner;
    conversation: () => EffectConversation | undefined;
    reply: () => TelegramReplyTarget | undefined;
    canSendStickers: () => boolean;
    canSendGifs: () => boolean;
    clearReply: () => void;
  },
  context: SessionContext<ExpressionSource>,
) {
  const scope = modelOwner({});
  type Model = {
    stickerOpen: boolean;
    gifOpen: boolean;
    visible: boolean;
    packLink: string | undefined;
  };
  type Message =
    | { type: 'PackLink'; value: string | undefined }
    | { type: 'Stickers' }
    | { type: 'Gifs' }
    | { type: 'Visible'; value: boolean }
    | { type: 'Close' };
  const state = program<Model, Message>({
    initial: { stickerOpen: false, gifOpen: false, visible: false, packLink: undefined },
    update: (model, message) => ({
      model:
        message.type === 'PackLink'
          ? { ...model, packLink: message.value }
          : message.type === 'Visible'
            ? { ...model, visible: message.value }
            : message.type === 'Close'
              ? { ...model, stickerOpen: false, gifOpen: false, packLink: undefined }
              : message.type === 'Stickers'
                ? { ...model, stickerOpen: !model.stickerOpen, gifOpen: false }
                : { ...model, gifOpen: !model.gifOpen, stickerOpen: false },
    }),
  });
  const stickers = observeQuery(scope, context.cache, stickerCatalog, context.changed);
  const savedGifs = observeQuery(scope, context.cache, gifCatalog, context.changed);
  const refresh = () => {
    stickers.select(state.model().stickerOpen || state.model().packLink ? true : undefined);
    savedGifs.select(state.model().gifOpen ? true : undefined);
  };
  scope.own(state.subscribe(refresh));
  scope.own(
    subscribeAtUi(
      options.runTask,
      options.source.subscribeResources(({ kind }) => {
        if (kind === 'expressions') {
          context.cache.invalidateQuery(stickerCatalog);
          context.cache.invalidateQuery(gifCatalog);
        }
      }),
    ),
  );
  const toggleStickers = () => state.send({ type: 'Stickers' });
  const toggleGifs = () => state.send({ type: 'Gifs' });
  const sendExpression = async (
    sticker: TelegramSticker,
    allowed: boolean,
    _kind: 'sticker' | 'gif',
  ) => {
    if (!allowed) return;
    const conversation = options.conversation();
    if (!conversation) return;
    const reply = options.reply();
    state.send({ type: 'Close' });
    options.clearReply();
    await options.runEffect(conversation.sendSticker(sticker, reply));
  };
  const actions = {
    stickerSearch: (query: string) => ({
      query,
      results: querySource(context.cache, stickerSearch, query),
      more: () => fetchNextPage(context.cache, stickerSearch, query),
      retry: () => context.cache.invalidateQuery(stickerSearch.query, query),
    }),
    openPackLink: (shortName: string) => state.send({ type: 'PackLink', value: shortName }),
    closePackLink: () => state.send({ type: 'PackLink', value: undefined }),
    setVisible: (value: boolean) => state.send({ type: 'Visible', value }),
    toggleStickers,
    toggleGifs,
    getStickerPack: (shortName: string) =>
      options.source.getStickerPack?.(shortName) ??
      Effect.fail(new Error('Sticker packs are unavailable.')),
    searchStickerPacks: (query: string) =>
      options.source.searchStickerPacks?.(query) ?? Effect.succeed([]),
    setStickerPackInstalled: (pack: TelegramStickerPack, installed: boolean) =>
      options.source.setStickerPackInstalled?.(pack, installed) ??
      Effect.fail(new Error('Sticker packs are unavailable.')),
    setStickerFavorite: (sticker: TelegramSticker, favorite: boolean) =>
      options.source.setStickerFavorite?.(sticker, favorite) ??
      Effect.fail(new Error('Favorite stickers are unavailable.')),
    retryStickers: () => Effect.sync(stickers.refresh),
    retryGifs: () => Effect.sync(savedGifs.refresh),
    sendSticker: (sticker: TelegramSticker) =>
      sendExpression(sticker, options.canSendStickers(), 'sticker'),
    sendGif: (sticker: TelegramSticker) => sendExpression(sticker, options.canSendGifs(), 'gif'),
    /** Cached GIF results for a search term in a chat; see `gifPeer` in the snapshot. */
    gifSearch: (peer: TelegramPeer, text: string) =>
      querySource(context.cache, gifSearch, { peer, text }),
    close: () => state.send({ type: 'Close' }),
  };
  return {
    ...actions,
    refresh,
    model: state.model,
    subscribe: state.subscribe,
    dispose: () => {
      scope.dispose();
      state.dispose();
    },
    snapshot: () => ({
      ...state.model(),
      ...actions,
      stickerPacks: available(stickers.read()) ?? [],
      gifs: available(savedGifs.read()) ?? [],
      stickerLoading: stickers.read().waiting && !available(stickers.read()),
      stickerError: resourceError(stickers.read()) ? 'Stickers could not be loaded.' : '',
      gifLoading: savedGifs.read().waiting,
      gifError: resourceError(savedGifs.read()) ? 'GIFs could not be loaded.' : '',
      /** The chat GIF search runs in, when sending GIFs is allowed there. */
      gifPeer: options.canSendGifs() ? options.conversation()?.peer : undefined,
    }),
  };
}
export type ExpressionSession = ReturnType<ReturnType<typeof createExpressionSession>['snapshot']>;
