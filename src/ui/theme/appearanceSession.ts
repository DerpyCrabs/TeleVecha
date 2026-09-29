import { Context, Effect } from 'effect';
import { lifetime, observeQuery, available, program, resourceError, query } from 'effectweb';
import type { SessionContext } from '../app/sessionContext';
import type { MessagingError } from '../../telegram/core/messagingError';
import type { TelegramWallpaper } from '../../telegram/types';
import type { UiEffectRunner } from '../app/appRuntime';
import { loadCustomWallpaper, saveCustomWallpaper } from './customWallpaperStore';
import type { ThemePreferences, ThemePresetId } from './themePreferences';
import {
  applyThemePreferences,
  normalizeThemePreferences,
  readThemePreferences,
  saveThemePreferences,
} from './themePreferences';
export interface AppearanceSource {
  getWallpapers(): Effect.Effect<TelegramWallpaper[], MessagingError>;
  downloadWallpaper(wallpaperId: string): Effect.Effect<Blob, MessagingError>;
}

export const AppearanceSource = Context.Service<AppearanceSource>('ui/AppearanceSource');
const wallpaperCatalog = query({
  name: 'wallpapers',
  load: () => Effect.flatMap(AppearanceSource, (source) => source.getWallpapers()),
});

/** Owns application-wide appearance persistence and wallpaper object URLs. */
export function createAppearanceSession(
  source: AppearanceSource,
  runEffect: UiEffectRunner,
  context: SessionContext<AppearanceSource>,
) {
  const scope = lifetime();
  type AppearanceSessionModel = {
    appearance: ThemePreferences;
    catalogRequested: boolean;
    wallpaperBusy: boolean;
    wallpaperError: string;
  };
  type AppearanceSessionMessage =
    | { type: 'Appearance'; value: ThemePreferences }
    | { type: 'CatalogRequested'; value: boolean }
    | { type: 'WallpaperBusy'; value: boolean }
    | { type: 'WallpaperError'; value: string };
  const state = program<AppearanceSessionModel, AppearanceSessionMessage>({
    initial: {
      appearance: readThemePreferences(),
      catalogRequested: false,
      wallpaperBusy: false,
      wallpaperError: '',
    },
    update: (model, message) => {
      switch (message.type) {
        case 'Appearance':
          return {
            model: Object.is(model.appearance, message.value)
              ? model
              : { ...model, appearance: message.value },
          };
        case 'CatalogRequested':
          return {
            model: Object.is(model.catalogRequested, message.value)
              ? model
              : { ...model, catalogRequested: message.value },
          };
        case 'WallpaperBusy':
          return {
            model: Object.is(model.wallpaperBusy, message.value)
              ? model
              : { ...model, wallpaperBusy: message.value },
          };
        case 'WallpaperError':
          return {
            model: Object.is(model.wallpaperError, message.value)
              ? model
              : { ...model, wallpaperError: message.value },
          };
      }
    },
  });
  const catalog = observeQuery(scope, context.cache, wallpaperCatalog, context.changed);
  const refresh = () => catalog.select(state.model().catalogRequested ? true : undefined);
  scope.add(state.subscribe(refresh));
  const telegramWallpapers = () => available(catalog.read()) ?? [];
  const catalogLoading = () => catalog.read().waiting;
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
  const loadStoredWallpaper = async (preferences = state.model().appearance) => {
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
      state.send({
        type: 'WallpaperError',
        value: cause instanceof Error ? cause.message : 'Could not load the saved background.',
      });
    }
  };
  const commit = (next: ThemePreferences) => {
    const normalized = normalizeThemePreferences(next);
    state.send({ type: 'Appearance', value: normalized });
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
    if (resourceError(catalog.read())) catalog.refresh();
    state.send({ type: 'CatalogRequested', value: true });
  };
  const selectWallpaper = (wallpaper: ThemePreferences['wallpaper']) => {
    const next = { ...state.model().appearance, wallpaper };
    commit(next);
    if (wallpaper === 'custom' || wallpaper === 'telegram')
      loadStoredWallpaper(next).catch(() => undefined);
  };
  const selectTelegramWallpaper = async (wallpaper: TelegramWallpaper) => {
    if (state.model().wallpaperBusy) return;
    state.send({ type: 'WallpaperBusy', value: true });
    state.send({ type: 'WallpaperError', value: '' });
    try {
      const blob = wallpaper.hasFile
        ? await runEffect(source.downloadWallpaper(wallpaper.id))
        : undefined;
      const next: ThemePreferences = {
        ...state.model().appearance,
        wallpaper: 'telegram',
        wallpaperBlur: wallpaper.settings.blur ? 8 : state.model().appearance.wallpaperBlur,
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
      state.send({
        type: 'WallpaperError',
        value: cause instanceof Error ? cause.message : 'Could not load the background.',
      });
    } finally {
      state.send({ type: 'WallpaperBusy', value: false });
    }
  };
  const uploadWallpaper = async (file: File) => {
    if (state.model().wallpaperBusy) return;
    state.send({ type: 'WallpaperBusy', value: true });
    state.send({ type: 'WallpaperError', value: '' });
    try {
      await runEffect(saveCustomWallpaper(file));
      commit({ ...state.model().appearance, wallpaper: 'custom' });
      showWallpaper(file);
    } catch (cause) {
      state.send({
        type: 'WallpaperError',
        value: cause instanceof Error ? cause.message : 'Could not save the background.',
      });
    } finally {
      state.send({ type: 'WallpaperBusy', value: false });
    }
  };
  (() => {
    const preferences = state.model().appearance;
    if (
      preferences.wallpaper === 'custom' ||
      (preferences.wallpaper === 'telegram' && preferences.telegramWallpaper?.hasFile)
    ) {
      loadStoredWallpaper(preferences).catch(() => undefined);
    }
  })();
  scope.add(() => {
    loadGeneration += 1;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
  const actions = {
    refresh,
    loadCatalog,
    selectTheme: (theme: ThemePresetId) => commit({ ...state.model().appearance, theme }),
    selectAccentColor: (accentColor: string) =>
      commit({ ...state.model().appearance, accentColor, systemAccent: false }),
    selectSystemAccent: (systemAccent: boolean) =>
      commit({ ...state.model().appearance, systemAccent }),
    selectChatFontSize: (chatFontSize: number) =>
      commit({ ...state.model().appearance, chatFontSize }),
    update: (changes: Partial<ThemePreferences>) =>
      commit({ ...state.model().appearance, ...changes }),
    selectWallpaper,
    selectTelegramWallpaper,
    uploadWallpaper,
  };
  return {
    ...actions,
    model: state.model,
    subscribe: state.subscribe,
    dispose: () => {
      scope.dispose();
      state.dispose();
    },
    snapshot: () => ({
      ...actions,
      appearance: state.model().appearance,
      telegramWallpapers: telegramWallpapers(),
      catalogLoading: catalogLoading(),
      wallpaperBusy: state.model().wallpaperBusy,
      wallpaperError: state.model().wallpaperError,
    }),
  };
}
