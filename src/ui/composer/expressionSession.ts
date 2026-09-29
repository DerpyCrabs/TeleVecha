import { Context, Effect } from 'effect';
import { lifetime, available, program, resourceError } from 'effectweb';
import type { SessionContext } from '../app/sessionContext';
import type { EffectConversation } from '../../telegram/core/conversation';
import type { MessagingError } from '../../telegram/core/messagingError';
import type {
  TelegramPeer,
  TelegramReplyTarget,
  TelegramResourceInvalidation,
  TelegramSticker,
  TelegramStickerPack,
} from '../../telegram/types';
import type { UiEffectRunner, UiTaskRunner } from '../app/appRuntime';
import { subscribeAtUi } from '../app/appRuntime';
import { observeQuery, query, querySource } from '@effectweb/query';
export interface ExpressionSource {
  getRecentStickers(): Effect.Effect<TelegramSticker[], MessagingError>;
  getStickerPacks(): Effect.Effect<TelegramStickerPack[], MessagingError>;
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
      Effect.all([source.getRecentStickers(), source.getStickerPacks()], {
        concurrency: 'unbounded',
      }).pipe(
        Effect.map(([recent, installed]) => [
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
  const scope = lifetime();
  type Model = { stickerOpen: boolean; gifOpen: boolean; visible: boolean };
  type Message =
    | { type: 'Stickers' }
    | { type: 'Gifs' }
    | { type: 'Visible'; value: boolean }
    | { type: 'Close' };
  const state = program<Model, Message>({
    initial: { stickerOpen: false, gifOpen: false, visible: false },
    update: (model, message) => ({
      model:
        message.type === 'Visible'
          ? { ...model, visible: message.value }
          : message.type === 'Close'
            ? { ...model, stickerOpen: false, gifOpen: false }
            : message.type === 'Stickers'
              ? { ...model, stickerOpen: !model.stickerOpen, gifOpen: false }
              : { ...model, gifOpen: !model.gifOpen, stickerOpen: false },
    }),
  });
  const stickers = observeQuery(scope, context.cache, stickerCatalog, context.changed);
  const savedGifs = observeQuery(scope, context.cache, gifCatalog, context.changed);
  const refresh = () => {
    stickers.select(state.model().stickerOpen ? true : undefined);
    savedGifs.select(state.model().gifOpen ? true : undefined);
  };
  scope.add(state.subscribe(refresh));
  scope.add(
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
    setVisible: (value: boolean) => state.send({ type: 'Visible', value }),
    toggleStickers,
    toggleGifs,
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
      stickerLoading: stickers.read().waiting,
      gifLoading: savedGifs.read().waiting,
      gifError: resourceError(savedGifs.read()) ? 'GIFs could not be loaded.' : '',
      /** The chat GIF search runs in, when sending GIFs is allowed there. */
      gifPeer: options.canSendGifs() ? options.conversation()?.peer : undefined,
    }),
  };
}
export type ExpressionSession = ReturnType<ReturnType<typeof createExpressionSession>['snapshot']>;
