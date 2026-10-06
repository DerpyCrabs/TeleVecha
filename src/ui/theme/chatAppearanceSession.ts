import { Context, Effect } from 'effect';
import { modelOwner, available } from 'effectweb';
import type { SessionContext } from '../app/sessionContext';
import type { MessagingError } from '../../telegram/core/messagingError';
import type { TelegramChatAppearance, TelegramDialog, TelegramPeer } from '../../telegram/types';
import type { UiEffectRunner } from '../app/appRuntime';
import type { ThemePreferences } from './themePreferences';
import { readableTextColor, telegramWallpaperBackground } from './themePreferences';
import { tvbugResourceState, type TvBugChatAppearanceState } from '../../debug/tvbugUiState';
import { observeQuery, query } from '@effectweb/query';
export interface ChatAppearanceSource {
  getChatAppearance(
    peer: TelegramPeer,
  ): Effect.Effect<TelegramChatAppearance | undefined, MessagingError>;
  downloadWallpaper(wallpaperId: string): Effect.Effect<Blob, MessagingError>;
}
export const ChatAppearanceSource =
  Context.Service<ChatAppearanceSource>('ui/ChatAppearanceSource');
export const chatAppearanceQuery = query({
  name: 'chat-appearance',
  load: (peer: TelegramPeer) =>
    Effect.flatMap(ChatAppearanceSource, (source) => source.getChatAppearance(peer)),
});
const wallpaperBlobQuery = query({
  name: 'wallpaper-blob',
  load: (id: string) =>
    Effect.flatMap(ChatAppearanceSource, (source) => source.downloadWallpaper(id)),
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
    activeDialog: () => TelegramDialog | undefined;
    online: () => boolean;
    preferences: () => ThemePreferences;
  },
  context: SessionContext<ChatAppearanceSource>,
) {
  const scope = modelOwner({});
  const appearanceResource = observeQuery(
    scope,
    context.cache,
    chatAppearanceQuery,
    context.changed,
  );
  const assetResource = observeQuery(scope, context.cache, wallpaperBlobQuery, context.changed);
  const chatAppearance = () => available(appearanceResource.read());
  let wasOnline = options.online();
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
    const online = options.online();
    const reconnected = online && !wasOnline;
    wasOnline = online;
    const dialog = options.activeDialog(),
      peer = dialog && !dialog.transient ? dialog.peer : undefined;
    appearanceResource.select(peer);
    const current = wallpaper();
    assetResource.select(current?.hasFile ? current.id : undefined);
    if (reconnected) {
      appearanceResource.refresh();
      if (!available(assetResource.read())) assetResource.refresh();
    }
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
  scope.own(() => {
    if (wallpaperAsset) URL.revokeObjectURL(wallpaperAsset);
  });
  return {
    refresh,
    dispose: () => scope.dispose(),
    diagnostics: (): TvBugChatAppearanceState => ({
      peerId: options.activeDialog()?.peer.id,
      value: chatAppearance(),
      appearance: tvbugResourceState(appearanceResource.read()),
      wallpaper: {
        ...tvbugResourceState(assetResource.read()),
        ...(previousBlob ? { byteSize: previousBlob.size, mimeType: previousBlob.type } : {}),
      },
      pattern: pattern() ?? 'none',
      selectedBaseTheme: settings()?.baseTheme,
    }),
    snapshot: () => ({
      settings: settings(),
      wallpaper: wallpaper(),
      pattern: pattern(),
      style: style(),
    }),
  };
}
