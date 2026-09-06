declare module 'node:fs/promises' {
  export function utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}

interface Window {
  __televechaTvBugBundle?: import('../src/debug/tvbugFormat').TvBugBundleV2;
  __televechaTvBugStatus?: import('../src/debug/tvbugRuntime').TvBugStatus;
  __televechaRuntimes?: Map<
    string,
    {
      engine: import('../src/telegram/core/client').EffectMessagingClient;
      runEffect: import('../src/ui/app/appRuntime').UiEffectRunner;
      transport: import('../src/telegram/types').TelegramTransport;
    }
  >;
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
      lastSendRandomId?: string;
      sendFile: number;
      sendAlbum: number;
      readHistory: number;
      readHistoryPeers: string[];
      getReadOutboxMaxId: number;
      downloadMedia: number;
      downloadMediaRequests: Array<{
        peerId: string;
        messageId: number;
        name: string | undefined;
        preview: boolean;
      }>;
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
      updateContact: number;
      deleteContact: number;
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
    holdNextUpload(): void;
    changeAndHoldReleaseAvatar(): void;
    failPendingAvatar(): void;
    failNextHistory(peerId: string, message: string): void;
    setBotCommands(
      peerId: string,
      commands: import('../src/telegram/types').TelegramBotCommand[],
    ): void;
    holdNextBotCallback(): void;
    releaseBotCallback(): void;
    holdNextBotStart(): void;
    releaseBotStart(): void;
    useExtendedUrlAuth(): void;
    readonly acceptedUrlAuthOptions:
      | import('../src/telegram/types').TelegramUrlAuthAcceptOptions
      | undefined;
    holdNextEdit(): void;
    releaseEdit(): void;
    releaseHistory(): void;
    releaseHistoryAround(): void;
    releaseSharedMediaCounts(): void;
  };
}
