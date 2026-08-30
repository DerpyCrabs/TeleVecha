import { createSignal, onCleanup, type Accessor } from 'solid-js';

import type { Conversation } from '../../telegram/core/conversation';
import type {
  TelegramReplyTarget,
  TelegramSticker,
  TelegramStickerPack,
  TelegramResourceInvalidation,
} from '../../telegram/types';

interface ExpressionSource {
  getRecentStickers(): Promise<TelegramSticker[]>;
  getStickerPacks(): Promise<TelegramStickerPack[]>;
  getSavedGifs(): Promise<TelegramSticker[]>;
  searchGifs(query: string): Promise<TelegramSticker[]>;
  subscribeResources(listener: (event: TelegramResourceInvalidation) => void): () => void;
}

/** Owns expression catalogs, picker exclusivity, invalidation, and sends. */
export function createExpressionSession(options: {
  source: ExpressionSource;
  conversation: Accessor<Conversation | undefined>;
  online: Accessor<boolean>;
  reply: Accessor<TelegramReplyTarget | undefined>;
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
      const [recent, installed] = await Promise.all([
        options.source.getRecentStickers(),
        options.source.getStickerPacks(),
      ]);
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
      setGifs(await options.source.getSavedGifs());
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
    options.source.subscribeResources(({ kind }) => {
      if (kind !== 'expressions') return;
      setStickerPacks([]);
      setGifs([]);
      if (stickerOpen()) void loadStickers().catch(() => undefined);
      if (gifOpen()) void loadGifs().catch(() => undefined);
    }),
  );

  const sendSticker = async (sticker: TelegramSticker) => {
    const conversation = options.conversation();
    if (!conversation || !options.online()) return;
    const reply = options.reply();
    setStickerOpen(false);
    options.clearReply();
    await conversation.sendSticker(sticker, reply);
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
    sendSticker,
    sendGif: async (gif: TelegramSticker) => {
      setGifOpen(false);
      await sendSticker(gif);
    },
    searchGifs: (query: string) => options.source.searchGifs(query),
    close: () => {
      setStickerOpen(false);
      setGifOpen(false);
    },
  };
}

export type ExpressionSession = ReturnType<typeof createExpressionSession>;
