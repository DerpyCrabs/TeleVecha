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
  const [stickerLoading, setStickerLoading] = createSignal(false);
  const [gifOpen, setGifOpen] = createSignal(false);
  const [gifLoading, setGifLoading] = createSignal(false);
  const [gifError, setGifError] = createSignal('');
  const [visible, setVisible] = createSignal(false);
  const [gifs, setGifs] = createSignal<TelegramSticker[]>([]);
  const [stickerPacks, setStickerPacks] = createSignal<TelegramStickerPack[]>([]);

  const loadStickers = async () => {
    if (stickerLoading()) return;
    setStickerLoading(true);
    try {
      const [recent, installed] = await options.runEffect(
        Effect.all([options.source.getRecentStickers(), options.source.getStickerPacks()], {
          concurrency: 'unbounded',
        }),
      );
      setStickerPacks([
        ...(recent.length > 0 ? [{ id: 'recent', title: 'Recent', stickers: recent }] : []),
        ...installed,
      ]);
    } finally {
      setStickerLoading(false);
    }
  };

  const loadGifs = async () => {
    if (gifLoading()) return;
    setGifLoading(true);
    setGifError('');
    try {
      setGifs(await options.runEffect(options.source.getSavedGifs()));
    } catch {
      setGifError('GIFs could not be loaded.');
    } finally {
      setGifLoading(false);
    }
  };

  const toggleStickers = async () => {
    const open = !stickerOpen();
    setStickerOpen(open);
    if (open) setGifOpen(false);
    if (open && stickerPacks().length === 0) await loadStickers();
  };

  const toggleGifs = async () => {
    const open = !gifOpen();
    setGifOpen(open);
    if (open) setStickerOpen(false);
    if (open && gifs().length === 0) await loadGifs();
  };

  onCleanup(
    subscribeAtUi(
      options.runEffect,
      options.source.subscribeResources(({ kind }) => {
        if (kind !== 'expressions') return;
        setStickerPacks([]);
        setGifs([]);
        if (stickerOpen()) void loadStickers().catch(() => undefined);
        if (gifOpen()) void loadGifs().catch(() => undefined);
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
      if (!options.canSendGifs()) return Promise.resolve([]);
      const conversation = options.conversation();
      return options.runEffect(conversation ? conversation.searchGifs(query) : Effect.succeed([]));
    },
    close: () => {
      setStickerOpen(false);
      setGifOpen(false);
    },
  };
}

export type ExpressionSession = ReturnType<typeof createExpressionSession>;
