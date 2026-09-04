import { createUiResource, useUiModel } from '../reactivity/solid';
import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { Effect } from 'effect';

import type { EffectConversation } from '../../telegram/core/conversation';
import type { MessagingError } from '../../telegram/core/messagingError';
import type {
  TelegramReplyTarget,
  TelegramSticker,
  TelegramStickerPack,
  TelegramResourceInvalidation,
} from '../../telegram/types';
import { subscribeAtUi, type UiEffectRunner } from '../app/appRuntime';

interface ExpressionSource {
  getRecentStickers(): Effect.Effect<TelegramSticker[], MessagingError>;
  getStickerPacks(): Effect.Effect<TelegramStickerPack[], MessagingError>;
  getSavedGifs(): Effect.Effect<TelegramSticker[], MessagingError>;
  subscribeResources(
    listener: (event: TelegramResourceInvalidation) => void,
  ): Effect.Effect<Effect.Effect<void>, MessagingError>;
}

/** Owns expression catalogs, picker exclusivity, invalidation, and sends. */
export function createExpressionSession(options: {
  source: ExpressionSource;
  runEffect: UiEffectRunner;
  conversation: Accessor<EffectConversation | undefined>;
  reply: Accessor<TelegramReplyTarget | undefined>;
  canSendStickers: Accessor<boolean>;
  canSendGifs: Accessor<boolean>;
  clearReply: () => void;
}) {
  const [stickerOpen, setStickerOpen] = createSignal(false);
  const [gifOpen, setGifOpen] = createSignal(false);
  const [visible, setVisible] = createSignal(false);
  const model = useUiModel();
  const [loadedStickers] = createUiResource(
    () => stickerOpen() && 'catalog',
    () =>
      Effect.all([options.source.getRecentStickers(), options.source.getStickerPacks()], {
        concurrency: 'unbounded',
      }).pipe(
        Effect.map(([recent, installed]) => [
          ...(recent.length ? [{ id: 'recent', title: 'Recent', stickers: recent }] : []),
          ...installed,
        ]),
      ),
    { namespace: 'expressions:stickers' },
  );
  const [loadedGifs, gifResource] = createUiResource(
    () => gifOpen() && 'catalog',
    () => options.source.getSavedGifs(),
    { namespace: 'expressions:gifs' },
  );
  const stickerPacks = () => loadedStickers() ?? [];
  const gifs = () => loadedGifs() ?? [];
  const stickerLoading = () => loadedStickers.loading;
  const gifLoading = () => loadedGifs.loading;
  const gifError = () => (loadedGifs.error ? 'GIFs could not be loaded.' : '');
  const toggleStickers = async () => {
    setStickerOpen(!stickerOpen());
    if (stickerOpen()) setGifOpen(false);
  };
  const toggleGifs = async () => {
    setGifOpen(!gifOpen());
    if (gifOpen()) setStickerOpen(false);
  };
  const loadGifs = async () => gifResource.refetch();

  onCleanup(
    subscribeAtUi(
      options.runEffect,
      options.source.subscribeResources(({ kind }) => {
        if (kind === 'expressions') model.invalidate('expressions:');
      }),
    ),
  );

  const sendExpression = async (
    sticker: TelegramSticker,
    allowed: boolean,
    kind: 'sticker' | 'gif',
  ) => {
    if (!allowed) return;
    const conversation = options.conversation();
    if (!conversation) return;
    const reply = options.reply();
    if (kind === 'gif') setGifOpen(false);
    else setStickerOpen(false);
    options.clearReply();
    await options.runEffect(conversation.sendSticker(sticker, reply));
  };

  return {
    stickerOpen,
    stickerLoading,
    gifOpen,
    gifLoading,
    gifError,
    visible,
    setVisible,
    gifs,
    stickerPacks,
    toggleStickers,
    toggleGifs,
    retryGifs: loadGifs,
    sendSticker: (sticker: TelegramSticker) =>
      sendExpression(sticker, options.canSendStickers(), 'sticker'),
    sendGif: async (gif: TelegramSticker) => {
      await sendExpression(gif, options.canSendGifs(), 'gif');
    },
    searchGifs: (query: string) => {
      if (!options.canSendGifs()) return Effect.succeed([]);
      const conversation = options.conversation();
      return conversation ? conversation.searchGifs(query) : Effect.succeed([]);
    },
    close: () => {
      setStickerOpen(false);
      setGifOpen(false);
    },
  };
}

export type ExpressionSession = ReturnType<typeof createExpressionSession>;
