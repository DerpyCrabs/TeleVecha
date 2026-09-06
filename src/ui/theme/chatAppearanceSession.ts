import type { Effect } from 'effect';
import type { MessagingError } from '../../telegram/core/messagingError';
import type { TelegramChatAppearance, TelegramDialog, TelegramPeer } from '../../telegram/types';
import type { UiEffectRunner } from '../app/appRuntime';
import type { Read, SessionContext } from 'effectweb/session';
import { lifetime, queryResource } from 'effectweb/session';
import { available, query } from 'effectweb';
import type { ThemePreferences } from './themePreferences';
import { readableTextColor, telegramWallpaperBackground } from './themePreferences';
interface ChatAppearanceSource {
  getChatAppearance(
    peer: TelegramPeer,
  ): Effect.Effect<TelegramChatAppearance | undefined, MessagingError>;
  downloadWallpaper(wallpaperId: string): Effect.Effect<Blob, MessagingError>;
}
export const chatAppearanceQuery = query({
  name: 'chat-appearance',
  key: ({ peer }: { source: ChatAppearanceSource; peer: TelegramPeer }) =>
    `${peer.kind}:${peer.id}:${peer.accessHash ?? ''}`,
  load: ({ source, peer }: { source: ChatAppearanceSource; peer: TelegramPeer }) =>
    source.getChatAppearance(peer),
});
const wallpaperBlobQuery = query({
  name: 'wallpaper-blob',
  key: ({ id }: { source: ChatAppearanceSource; id: string }) => id,
  load: ({ source, id }: { source: ChatAppearanceSource; id: string }) =>
    source.downloadWallpaper(id),
});
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
export function createChatAppearanceSession(
  options: {
    source: ChatAppearanceSource;
    runEffect: UiEffectRunner;
    activeDialog: Read<TelegramDialog | undefined>;
    preferences: Read<ThemePreferences>;
  },
  context: SessionContext,
) {
  const scope = lifetime();
  const appearanceResource = queryResource(context, chatAppearanceQuery);
  const assetResource = queryResource(context, wallpaperBlobQuery);
  scope.add(appearanceResource.dispose);
  scope.add(assetResource.dispose);
  const chatAppearance = () => available(appearanceResource.read());
  let wallpaperAsset = '',
    previousBlob: Blob | undefined;
  let lastReported: TelegramChatAppearance | undefined,
    lastPreferences: ThemePreferences | undefined;
  const settings = () => themeSettings(chatAppearance(), options.preferences());
  const wallpaper = () => chatAppearance()?.wallpaper ?? settings()?.wallpaper;
  const pattern = () => {
    const current = wallpaper();
    if (!current?.pattern) return undefined;
    const baseTheme = settings()?.baseTheme;
    return current.dark ||
      (current.settings.intensity ?? 50) < 0 ||
      baseTheme === 'night' ||
      baseTheme === 'tinted'
      ? 'inverted'
      : 'normal';
  };
  const style = () => {
    const currentSettings = settings();
    const currentWallpaper = wallpaper();
    const colors = currentWallpaper?.settings.backgroundColors.length
      ? currentWallpaper.settings.backgroundColors
      : undefined;
    return {
      ...(wallpaperAsset ? { '--chat-wallpaper-asset': `url("${wallpaperAsset}")` } : {}),
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
  };
  const refresh = () => {
    const dialog = options.activeDialog(),
      peer = dialog && !dialog.transient ? dialog.peer : undefined;
    appearanceResource.select(peer ? { source: options.source, peer } : undefined);
    const current = wallpaper();
    assetResource.select(current?.hasFile ? { source: options.source, id: current.id } : undefined);
    const blob = available(assetResource.read());
    if (blob !== previousBlob) {
      if (wallpaperAsset) URL.revokeObjectURL(wallpaperAsset);
      previousBlob = blob;
      wallpaperAsset = blob ? URL.createObjectURL(blob) : '';
    }
    const appearance = chatAppearance(),
      preferences = options.preferences();
    if (peer && appearance && (appearance !== lastReported || preferences !== lastPreferences)) {
      lastReported = appearance;
      lastPreferences = preferences;
      reportAppearance(peer, appearance, preferences);
    }
  };
  scope.add(() => {
    if (wallpaperAsset) URL.revokeObjectURL(wallpaperAsset);
  });
  return {
    refresh,
    dispose: () => scope.dispose(),
    snapshot: () => ({
      settings: settings(),
      wallpaper: wallpaper(),
      pattern: pattern(),
      style: style(),
    }),
  };
}
