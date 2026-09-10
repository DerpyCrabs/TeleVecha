import { Context, Effect } from 'effect';
import type { EffectConversation } from '../../telegram/core/conversation';
import type { MessagingError } from '../../telegram/core/messagingError';
import type {
  TelegramReplyTarget,
  TelegramResourceInvalidation,
  TelegramSticker,
  TelegramStickerPack,
} from '../../telegram/types';
import type { UiEffectRunner } from '../app/appRuntime';
import { subscribeAtUi } from '../app/appRuntime';
import type { Read, SessionContext } from 'effectweb/session';
import { lifetime, queryResource } from 'effectweb/session';
import { query } from 'effectweb/query';
import { available, program, resourceError } from 'effectweb';
export interface ExpressionSource {
  getRecentStickers(): Effect.Effect<TelegramSticker[], MessagingError>;
  getStickerPacks(): Effect.Effect<TelegramStickerPack[], MessagingError>;
  getSavedGifs(): Effect.Effect<TelegramSticker[], MessagingError>;
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

/** Owns expression catalogs, picker exclusivity, invalidation, and sends. */
export function createExpressionSession(
  options: {
    source: ExpressionSource;
    runEffect: UiEffectRunner;
    conversation: Read<EffectConversation | undefined>;
    reply: Read<TelegramReplyTarget | undefined>;
    canSendStickers: Read<boolean>;
    canSendGifs: Read<boolean>;
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
  const stickers = queryResource(context, stickerCatalog);
  const savedGifs = queryResource(context, gifCatalog);
  const refresh = () => {
    stickers.select(state.model().stickerOpen ? true : undefined);
    savedGifs.select(state.model().gifOpen ? true : undefined);
  };
  scope.add(state.subscribe(refresh));
  scope.add(stickers.dispose);
  scope.add(savedGifs.dispose);
  scope.add(
    subscribeAtUi(
      options.runEffect,
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
    searchGifs: (query: string) => {
      const conversation = options.conversation();
      return options.canSendGifs() && conversation
        ? conversation.searchGifs(query)
        : Effect.succeed([]);
    },
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
    }),
  };
}
export type ExpressionSession = ReturnType<ReturnType<typeof createExpressionSession>['snapshot']>;
