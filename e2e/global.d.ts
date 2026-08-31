declare module 'node:fs/promises' {
  export function utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}

interface Window {
  __televechaReproBundle?: import('../src/debug/reproFormat').ReproBundleV1;
  __televechaReproStatus?: import('../src/debug/reproRuntime').ReproStatus;
  __televechaRuntimes?: Map<
    string,
    {
      engine: import('../src/telegram/core/engine').MessagingEngine;
      transport: import('../src/telegram/types').TelegramTransport;
    }
  >;
  __releaseFixtureEdit?: () => void;
  __releaseFixtureCallback?: () => void;
  __releaseFixtureAddPeer?: () => void;
  __releaseFixtureOpenConversation?: () => void;
  __releaseFixtureBotStartOne?: () => void;
  __releaseFixtureBotStartTwo?: () => void;
  __openedBotUrl?: string;
  __acceptedUrlAuthOptions?: import('../src/telegram/types').TelegramUrlAuthAcceptOptions;
  __intersectionObserverConstructions?: number;
  __televechaFixture?: {
    stats: {
      connect: number;
      getAuthorizedAccountId: number;
      getChannelDifference: number;
      requestCode: number;
      submitCode: number;
      submitPassword: number;
      getDialogs: number;
      getHistory: number;
      getHistoryAround: number;
      getSharedMediaCounts: number;
      sendText: number;
      sendFile: number;
      sendAlbum: number;
      readHistory: number;
      readHistoryPeers: string[];
      getReadOutboxMaxId: number;
      downloadMedia: number;
      downloadMediaPreview: number;
      downloadMediaFull: number;
      downloadAvatar: number;
      releaseAvatarDownload: number;
      getThemes: number;
      getWallpapers: number;
      getChatAppearance: number;
      downloadWallpaper: number;
      getRecentStickers: number;
      getStickerPacks: number;
      getSavedGifs: number;
      searchGifs: number;
      downloadSticker: number;
      getBotCommands: number;
      startBot: number;
      answerBotCallback: number;
      sendSticker: number;
      setReaction: number;
      deleteMessages: number;
      editMessage: number;
      forwardMessage: number;
      searchMessages: number;
      searchPeers: number;
      getSharedMedia: number;
      getPinnedMessages: number;
      setMuted: number;
      getUserDetails: number;
      setBlocked: number;
      setPinnedDialog: number;
      setArchived: number;
      deleteDialog: number;
      setPinnedMessage: number;
      setTyping: number;
    };
    emit(update: import('../src/telegram/types').TransportUpdate): void;
    releaseConnect(): void;
    releaseSend(): void;
    releaseUpload(): void;
    changeAndHoldReleaseAvatar(): void;
    failPendingAvatar(): void;
    releaseHistory(): void;
    releaseHistoryAround(): void;
    releaseSharedMediaCounts(): void;
  };
}
