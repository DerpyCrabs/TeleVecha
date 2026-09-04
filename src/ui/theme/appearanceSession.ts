import { createSignal, onCleanup, onMount } from 'solid-js';
import type { Effect } from 'effect';

import type { TelegramWallpaper } from '../../telegram/types';
import type { MessagingError } from '../../telegram/core/messagingError';
import { loadCustomWallpaper, saveCustomWallpaper } from './customWallpaperStore';
import type { UiEffectRunner } from '../app/appRuntime';
import {
  applyThemePreferences,
  normalizeThemePreferences,
  readThemePreferences,
  saveThemePreferences,
  type ThemePreferences,
  type ThemePresetId,
} from './themePreferences';

interface AppearanceSource {
  getWallpapers(): Effect.Effect<TelegramWallpaper[], MessagingError>;
  downloadWallpaper(wallpaperId: string): Effect.Effect<Blob, MessagingError>;
}

/** Owns application-wide appearance persistence and wallpaper object URLs. */
export function createAppearanceSession(source: AppearanceSource, runEffect: UiEffectRunner) {
  const [appearance, setAppearance] = createSignal(readThemePreferences());
  const [telegramWallpapers, setTelegramWallpapers] = createSignal<TelegramWallpaper[]>([]);
  const [catalogLoading, setCatalogLoading] = createSignal(false);
  const [wallpaperBusy, setWallpaperBusy] = createSignal(false);
  const [wallpaperError, setWallpaperError] = createSignal('');
  let loadGeneration = 0;
  let objectUrl: string | undefined;

  const showWallpaper = (blob?: Blob) => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = blob ? URL.createObjectURL(blob) : undefined;
    if (objectUrl) {
      document.documentElement.style.setProperty('--wallpaper-asset', `url("${objectUrl}")`);
    } else {
      document.documentElement.style.removeProperty('--wallpaper-asset');
    }
  };

  const loadStoredWallpaper = async (preferences = appearance()) => {
    const generation = ++loadGeneration;
    try {
      const blob =
        preferences.wallpaper === 'custom'
          ? await runEffect(loadCustomWallpaper)
          : preferences.wallpaper === 'telegram' && preferences.telegramWallpaper?.hasFile
            ? await runEffect(source.downloadWallpaper(preferences.telegramWallpaper.id))
            : undefined;
      if (generation === loadGeneration) showWallpaper(blob);
    } catch (cause) {
      if (generation !== loadGeneration) return;
      showWallpaper();
      setWallpaperError(
        cause instanceof Error ? cause.message : 'Could not load the saved background.',
      );
    }
  };

  const commit = (next: ThemePreferences) => {
    const normalized = normalizeThemePreferences(next);
    setAppearance(normalized);
    applyThemePreferences(normalized);
    try {
      saveThemePreferences(normalized);
    } catch {
      // The tab can still use the selection when persistent storage is unavailable.
    }
    if (normalized.wallpaper !== 'custom' && normalized.wallpaper !== 'telegram') {
      loadGeneration += 1;
      showWallpaper();
    }
  };

  const loadCatalog = async () => {
    if (catalogLoading()) return;
    setCatalogLoading(true);
    try {
      setTelegramWallpapers(await runEffect(source.getWallpapers()));
    } catch {
      setTelegramWallpapers([]);
    } finally {
      setCatalogLoading(false);
    }
  };

  const selectWallpaper = (wallpaper: ThemePreferences['wallpaper']) => {
    const next = { ...appearance(), wallpaper };
    commit(next);
    if (wallpaper === 'custom' || wallpaper === 'telegram') void loadStoredWallpaper(next);
  };

  const selectTelegramWallpaper = async (wallpaper: TelegramWallpaper) => {
    if (wallpaperBusy()) return;
    setWallpaperBusy(true);
    setWallpaperError('');
    try {
      const blob = wallpaper.hasFile
        ? await runEffect(source.downloadWallpaper(wallpaper.id))
        : undefined;
      const next: ThemePreferences = {
        ...appearance(),
        wallpaper: 'telegram',
        wallpaperBlur: wallpaper.settings.blur ? 8 : appearance().wallpaperBlur,
        telegramWallpaper: {
          id: wallpaper.id,
          label: wallpaper.slug || `Telegram ${wallpaper.id}`,
          backgroundColors: wallpaper.settings.backgroundColors,
          rotation: wallpaper.settings.rotation ?? 135,
          hasFile: wallpaper.hasFile,
          pattern: wallpaper.pattern,
          dark: wallpaper.dark,
          ...(wallpaper.settings.intensity !== undefined
            ? { intensity: wallpaper.settings.intensity }
            : {}),
        },
      };
      commit(next);
      showWallpaper(blob);
    } catch (cause) {
      setWallpaperError(cause instanceof Error ? cause.message : 'Could not load the background.');
    } finally {
      setWallpaperBusy(false);
    }
  };

  const uploadWallpaper = async (file: File) => {
    if (wallpaperBusy()) return;
    setWallpaperBusy(true);
    setWallpaperError('');
    try {
      await runEffect(saveCustomWallpaper(file));
      commit({ ...appearance(), wallpaper: 'custom' });
      showWallpaper(file);
    } catch (cause) {
      setWallpaperError(cause instanceof Error ? cause.message : 'Could not save the background.');
    } finally {
      setWallpaperBusy(false);
    }
  };

  onMount(() => {
    const preferences = appearance();
    if (
      preferences.wallpaper === 'custom' ||
      (preferences.wallpaper === 'telegram' && preferences.telegramWallpaper?.hasFile)
    ) {
      void loadStoredWallpaper(preferences);
    }
  });
  onCleanup(() => {
    loadGeneration += 1;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  return {
    appearance,
    telegramWallpapers,
    catalogLoading,
    wallpaperBusy,
    wallpaperError,
    loadCatalog,
    selectTheme: (theme: ThemePresetId) => commit({ ...appearance(), theme }),
    selectAccentColor: (accentColor: string) =>
      commit({ ...appearance(), accentColor, systemAccent: false }),
    selectSystemAccent: (systemAccent: boolean) => commit({ ...appearance(), systemAccent }),
    selectChatFontSize: (chatFontSize: number) => commit({ ...appearance(), chatFontSize }),
    update: (changes: Partial<ThemePreferences>) => commit({ ...appearance(), ...changes }),
    selectWallpaper,
    selectTelegramWallpaper,
    uploadWallpaper,
  };
}
