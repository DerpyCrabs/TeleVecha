import { createEffect, createMemo, onCleanup, type Accessor } from 'solid-js';
import { createUiResource } from '../reactivity/solid';
import type { Effect } from 'effect';

import type { TelegramChatAppearance, TelegramDialog, TelegramPeer } from '../../telegram/types';
import type { MessagingError } from '../../telegram/core/messagingError';
import type { UiEffectRunner } from '../app/appRuntime';
import {
  readableTextColor,
  telegramWallpaperBackground,
  type ThemePreferences,
} from './themePreferences';

interface ChatAppearanceSource {
  getChatAppearance(
    peer: TelegramPeer,
  ): Effect.Effect<TelegramChatAppearance | undefined, MessagingError>;
  downloadWallpaper(wallpaperId: string): Effect.Effect<Blob, MessagingError>;
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
  runEffect: UiEffectRunner;
  activeDialog: Accessor<TelegramDialog | undefined>;
  preferences: Accessor<ThemePreferences>;
}) {
  const [chatAppearance] = createUiResource(
    () => {
      const dialog = options.activeDialog();
      return dialog && !dialog.transient ? dialog.peer : false;
    },
    (peer) => options.source.getChatAppearance(peer),
    {
      namespace: 'chat-appearance',
      key: (peer) => `${peer.kind}:${peer.id}:${peer.accessHash ?? ''}`,
    },
  );

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
  const [wallpaperBlob] = createUiResource(
    () => {
      const current = wallpaper();
      return current?.hasFile ? current.id : false;
    },
    (id) => options.source.downloadWallpaper(id),
    { namespace: 'wallpaper-blob' },
  );
  const wallpaperAsset = createMemo(() => {
    const blob = wallpaperBlob();
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    onCleanup(() => URL.revokeObjectURL(url));
    return url;
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

  createEffect(() => {
    const peer = options.activeDialog()?.peer;
    const appearance = chatAppearance();
    if (peer && appearance) reportAppearance(peer, appearance, options.preferences());
  });

  return { settings, wallpaper, pattern, style };
}
