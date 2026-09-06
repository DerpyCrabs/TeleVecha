import { Schema } from 'effect';

import type {
  TelegramChatAppearance,
  TelegramSticker,
  TelegramStickerPack,
  TelegramWallpaper,
} from '../types';

const StoredSticker = Schema.Struct({
  id: Schema.String,
  accessHash: Schema.String,
  fileReference: Schema.Array(Schema.Number),
  emoji: Schema.String,
  mimeType: Schema.String,
  dcId: Schema.optionalKey(Schema.Number),
  size: Schema.optionalKey(Schema.Number),
  title: Schema.optionalKey(Schema.String),
  inlineQueryId: Schema.optionalKey(Schema.String),
  inlineResultId: Schema.optionalKey(Schema.String),
});
const StoredStickerPack = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  stickers: Schema.Array(StoredSticker),
});
const WallpaperSettings = Schema.Struct({
  backgroundColors: Schema.Array(Schema.String),
  blur: Schema.Boolean,
  motion: Schema.Boolean,
  intensity: Schema.optionalKey(Schema.Number),
  rotation: Schema.optionalKey(Schema.Number),
  emoticon: Schema.optionalKey(Schema.String),
});
const Wallpaper = Schema.Struct({
  id: Schema.String,
  slug: Schema.optionalKey(Schema.String),
  dark: Schema.Boolean,
  pattern: Schema.Boolean,
  hasFile: Schema.Boolean,
  settings: WallpaperSettings,
});
const ThemeSettings = Schema.Struct({
  baseTheme: Schema.Literals(['classic', 'day', 'night', 'tinted', 'arctic']),
  accentColor: Schema.String,
  outboxAccentColor: Schema.optionalKey(Schema.String),
  messageColors: Schema.Array(Schema.String),
  messageColorsAnimated: Schema.Boolean,
  wallpaper: Schema.optionalKey(Wallpaper),
});
const Theme = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  emoticon: Schema.optionalKey(Schema.String),
  default: Schema.Boolean,
  forChat: Schema.Boolean,
  settings: Schema.Array(ThemeSettings),
});
const ChatAppearance = Schema.Struct({
  theme: Schema.optionalKey(Theme),
  wallpaper: Schema.optionalKey(Wallpaper),
});
const ChatAppearanceEntry = Schema.Struct({
  savedAt: Schema.Number,
  value: Schema.NullOr(ChatAppearance),
});

const decodeStickerList = Schema.decodeUnknownSync(Schema.Array(StoredSticker));
const decodeStickerPacks = Schema.decodeUnknownSync(Schema.Array(StoredStickerPack));
const decodeChatAppearance = Schema.decodeUnknownSync(ChatAppearanceEntry);

const stickerFromStorage = (sticker: typeof StoredSticker.Type): TelegramSticker => ({
  ...sticker,
  fileReference: new Uint8Array(sticker.fileReference),
});
const stickerForStorage = (sticker: TelegramSticker) => ({
  ...sticker,
  fileReference: [...sticker.fileReference],
});

const wallpaperFromStorage = (wallpaper: typeof Wallpaper.Type): TelegramWallpaper => ({
  ...wallpaper,
  settings: { ...wallpaper.settings, backgroundColors: [...wallpaper.settings.backgroundColors] },
});

const chatAppearanceFromStorage = (
  appearance: typeof ChatAppearance.Type,
): TelegramChatAppearance => ({
  ...(appearance.theme
    ? {
        theme: {
          ...appearance.theme,
          settings: appearance.theme.settings.map(({ wallpaper, ...settings }) => ({
            ...settings,
            messageColors: [...settings.messageColors],
            ...(wallpaper ? { wallpaper: wallpaperFromStorage(wallpaper) } : {}),
          })),
        },
      }
    : {}),
  ...(appearance.wallpaper ? { wallpaper: wallpaperFromStorage(appearance.wallpaper) } : {}),
});

export function parseStickerListCache(text: string): TelegramSticker[] {
  return decodeStickerList(JSON.parse(text)).map(stickerFromStorage);
}

export function serializeStickerListCache(stickers: readonly TelegramSticker[]) {
  return JSON.stringify(stickers.map(stickerForStorage));
}

export function parseStickerPacksCache(text: string): TelegramStickerPack[] {
  return decodeStickerPacks(JSON.parse(text)).map((pack) => ({
    ...pack,
    stickers: pack.stickers.map(stickerFromStorage),
  }));
}

export function serializeStickerPacksCache(packs: readonly TelegramStickerPack[]) {
  return JSON.stringify(
    packs.map((pack) => ({ ...pack, stickers: pack.stickers.map(stickerForStorage) })),
  );
}

export function parseChatAppearanceCache(text: string): {
  savedAt: number;
  value: TelegramChatAppearance | undefined;
} {
  const entry = decodeChatAppearance(JSON.parse(text));
  return {
    savedAt: entry.savedAt,
    value: entry.value ? chatAppearanceFromStorage(entry.value) : undefined,
  };
}

export function serializeChatAppearanceCache(
  savedAt: number,
  value: TelegramChatAppearance | undefined,
) {
  return JSON.stringify({ savedAt, value: value ?? null });
}
