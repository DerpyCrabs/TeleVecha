import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
  type Accessor,
} from 'solid-js';

import type { TelegramChatAppearance, TelegramDialog, TelegramPeer } from '../../telegram/types';
import {
  readableTextColor,
  telegramWallpaperBackground,
  type ThemePreferences,
} from './themePreferences';

interface ChatAppearanceSource {
  getChatAppearance(peer: TelegramPeer): Promise<TelegramChatAppearance | undefined>;
  downloadWallpaper(wallpaperId: string): Promise<Blob>;
}

function themeSettings(
  chatAppearance: TelegramChatAppearance | undefined,
  preferences: ThemePreferences,
) {
  const preferredBase =
    preferences.theme === 'day' || preferences.theme === 'classic'
      ? preferences.theme
      : preferences.theme === 'tinted'
        ? 'tinted'
        : 'night';
  const settings = chatAppearance?.theme?.settings;
  return (
    settings?.find(({ baseTheme }) => baseTheme === preferredBase) ??
    (preferredBase === 'night' || preferredBase === 'tinted'
      ? settings?.find(({ baseTheme }) => baseTheme === 'tinted' || baseTheme === 'night')
      : undefined) ??
    settings?.[0]
  );
}

function reportAppearance(
  peer: TelegramPeer,
  chatAppearance: TelegramChatAppearance,
  preferences: ThemePreferences,
) {
  const settings = themeSettings(chatAppearance, preferences);
  const wallpaper = chatAppearance.wallpaper ?? settings?.wallpaper;
  const patternMode = wallpaper?.pattern
    ? wallpaper.dark ||
      (wallpaper.settings.intensity ?? 50) < 0 ||
      settings?.baseTheme === 'night' ||
      settings?.baseTheme === 'tinted'
      ? 'inverted'
      : 'normal'
    : 'none';
  console.debug('[televecha] Telegram appearance', {
    peer: { id: peer.id, kind: peer.kind },
    appTheme: preferences.theme,
    selectedThemeSettings: settings,
    selectedWallpaper: wallpaper,
    patternMode,
  });
}

/** Owns chat-scoped Telegram theme resolution, downloads, and object URLs. */
export function createChatAppearanceSession(options: {
  source: ChatAppearanceSource;
  activeDialog: Accessor<TelegramDialog | undefined>;
  preferences: Accessor<ThemePreferences>;
}) {
  const [chatAppearance, setChatAppearance] = createSignal<TelegramChatAppearance>();
  const [wallpaperAsset, setWallpaperAsset] = createSignal('');
  const appearances = new Map<string, TelegramChatAppearance>();
  const wallpaperObjectUrls = new Map<string, string>();
  let loadGeneration = 0;

  const settings = createMemo(() => themeSettings(chatAppearance(), options.preferences()));
  const wallpaper = createMemo(() => chatAppearance()?.wallpaper ?? settings()?.wallpaper);
  const pattern = createMemo(() => {
    const current = wallpaper();
    if (!current?.pattern) return undefined;
    const baseTheme = settings()?.baseTheme;
    return current.dark ||
      (current.settings.intensity ?? 50) < 0 ||
      baseTheme === 'night' ||
      baseTheme === 'tinted'
      ? 'inverted'
      : 'normal';
  });
  const style = createMemo(() => {
    const currentSettings = settings();
    const currentWallpaper = wallpaper();
    const colors = currentWallpaper?.settings.backgroundColors.length
      ? currentWallpaper.settings.backgroundColors
      : undefined;
    return {
      ...(wallpaperAsset() ? { '--chat-wallpaper-asset': `url("${wallpaperAsset()}")` } : {}),
      ...(colors
        ? {
            '--chat-wallpaper-gradient': telegramWallpaperBackground(
              colors,
              currentWallpaper?.settings.rotation ?? 135,
            ),
          }
        : {}),
      ...(currentSettings
        ? {
            '--chat-accent': currentSettings.accentColor,
            '--chat-outbox-accent':
              currentSettings.outboxAccentColor ?? currentSettings.accentColor,
            '--chat-message-1':
              currentSettings.messageColors[0] ??
              currentSettings.outboxAccentColor ??
              currentSettings.accentColor,
            '--chat-message-2':
              currentSettings.messageColors[1] ??
              currentSettings.messageColors[0] ??
              currentSettings.outboxAccentColor ??
              currentSettings.accentColor,
            '--chat-message-text': readableTextColor(
              currentSettings.messageColors[0] ??
                currentSettings.outboxAccentColor ??
                currentSettings.accentColor,
            ),
          }
        : {}),
      ...(currentWallpaper?.settings.blur ? { '--chat-wallpaper-blur': '8px' } : {}),
      ...(currentWallpaper?.pattern
        ? {
            '--chat-wallpaper-intensity': `${Math.abs(currentWallpaper.settings.intensity ?? 50) / 100}`,
          }
        : {}),
    };
  });

  createEffect(
    on(
      () => {
        const dialog = options.activeDialog();
        return dialog && !dialog.transient
          ? `${dialog.peer.kind}:${dialog.peer.id}:${dialog.peer.accessHash ?? ''}`
          : '';
      },
      () => {
        const dialog = untrack(options.activeDialog);
        const generation = ++loadGeneration;
        if (!dialog || dialog.transient) {
          batch(() => {
            setChatAppearance(undefined);
            setWallpaperAsset('');
          });
          return;
        }
        const cachedAppearance = appearances.get(dialog.peer.id);
        const cachedSettings = themeSettings(cachedAppearance, options.preferences());
        const cachedWallpaper = cachedAppearance?.wallpaper ?? cachedSettings?.wallpaper;
        batch(() => {
          setChatAppearance(cachedAppearance);
          setWallpaperAsset(
            cachedWallpaper ? (wallpaperObjectUrls.get(cachedWallpaper.id) ?? '') : '',
          );
        });
        void options.source
          .getChatAppearance(dialog.peer)
          .then(async (nextAppearance) => {
            if (!nextAppearance) return;
            appearances.set(dialog.peer.id, nextAppearance);
            if (generation === loadGeneration) {
              reportAppearance(dialog.peer, nextAppearance, options.preferences());
            }
            const nextSettings = themeSettings(nextAppearance, options.preferences());
            const nextWallpaper = nextAppearance.wallpaper ?? nextSettings?.wallpaper;
            if (!nextWallpaper?.hasFile) {
              if (generation === loadGeneration) setChatAppearance(nextAppearance);
              return;
            }
            const cachedObjectUrl = wallpaperObjectUrls.get(nextWallpaper.id);
            if (cachedObjectUrl) {
              if (generation === loadGeneration) {
                batch(() => {
                  setWallpaperAsset(cachedObjectUrl);
                  setChatAppearance(nextAppearance);
                });
              }
              return;
            }
            if (generation === loadGeneration) setChatAppearance(nextAppearance);
            const blob = await options.source.downloadWallpaper(nextWallpaper.id);
            let objectUrl = wallpaperObjectUrls.get(nextWallpaper.id);
            if (!objectUrl) {
              objectUrl = URL.createObjectURL(blob);
              wallpaperObjectUrls.set(nextWallpaper.id, objectUrl);
            }
            if (generation === loadGeneration) setWallpaperAsset(objectUrl);
          })
          .catch(() => undefined);
      },
    ),
  );

  onCleanup(() => {
    loadGeneration += 1;
    for (const objectUrl of wallpaperObjectUrls.values()) URL.revokeObjectURL(objectUrl);
    wallpaperObjectUrls.clear();
  });

  return { settings, wallpaper, pattern, style };
}
