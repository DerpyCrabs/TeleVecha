export const THEME_STORAGE_KEY = 'televecha:appearance';
const THEME_PREFERENCES_VERSION = 5;
export const MIN_CHAT_FONT_SIZE = 12;
export const MAX_CHAT_FONT_SIZE = 24;
export const DEFAULT_CHAT_FONT_SIZE = 15;

export const ACCENT_COLORS = [
  '#43c6bd',
  '#58a8e8',
  '#4fa45f',
  '#c97899',
  '#d99a58',
  '#9b82d0',
  '#d77570',
  '#8795aa',
  '#d3af62',
] as const;

export const THEME_OPTIONS = [
  {
    id: 'classic',
    label: 'Classic',
    description: 'Telegram Desktop classic colors',
    swatches: ['#ffffff', '#e1ffc7', '#3390ec'],
  },
  {
    id: 'day',
    label: 'Day',
    description: 'Telegram Desktop light colors',
    swatches: ['#ffffff', '#e9f5ff', '#3390ec'],
  },
  {
    id: 'tinted',
    label: 'Tinted',
    description: 'Telegram Desktop tinted colors',
    swatches: ['#202b36', '#2b5278', '#64a9e8'],
  },
  {
    id: 'night',
    label: 'Night',
    description: 'Telegram Desktop night colors',
    swatches: ['#15181d', '#233549', '#6da9f7'],
  },
] as const;

export const WALLPAPER_OPTIONS = [
  { id: 'doodles', label: 'Doodles' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'none', label: 'Plain' },
] as const;

export type ThemePresetId = (typeof THEME_OPTIONS)[number]['id'];
export type ThemeId = ThemePresetId | 'telegram';
export type WallpaperId = (typeof WALLPAPER_OPTIONS)[number]['id'] | 'custom' | 'telegram';

export interface TelegramThemePreference {
  id: string;
  title: string;
  baseTheme: 'classic' | 'day' | 'night' | 'tinted' | 'arctic';
  accentColor: string;
  outboxAccentColor?: string | undefined;
  messageColors: readonly string[];
}

export interface TelegramWallpaperPreference {
  id: string;
  label: string;
  backgroundColors: readonly string[];
  rotation: number;
  hasFile: boolean;
  pattern: boolean;
  dark: boolean;
  intensity?: number | undefined;
}

export interface ThemePreferences {
  theme: ThemeId;
  accentColor: string;
  systemAccent: boolean;
  wallpaper: WallpaperId;
  wallpaperBlur: number;
  wallpaperDim: number;
  chatFontSize: number;
  telegramTheme?: TelegramThemePreference | undefined;
  telegramWallpaper?: TelegramWallpaperPreference | undefined;
}

export const DEFAULT_THEME_PREFERENCES: ThemePreferences = {
  theme: 'night',
  accentColor: '#58a8e8',
  systemAccent: false,
  wallpaper: 'none',
  wallpaperBlur: 0,
  wallpaperDim: 18,
  chatFontSize: DEFAULT_CHAT_FONT_SIZE,
};

const themeIds = new Set<string>(THEME_OPTIONS.map(({ id }) => id));
const wallpaperIds = new Set<string>([
  ...WALLPAPER_OPTIONS.map(({ id }) => id),
  'custom',
  'telegram',
]);
const baseThemeIds = new Set(['classic', 'day', 'night', 'tinted', 'arctic']);
const colorPattern = /^#[\da-f]{6}$/iu;

export function readableTextColor(background: string) {
  const value = safeColor(background);
  if (!value) return '#f2f6fa';
  const channels = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const luminance = channels.reduce((total, channel, index) => {
    const linear =
      channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4;
    return total + linear * [0.2126, 0.7152, 0.0722][index]!;
  }, 0);
  return luminance > 0.46 ? '#18212b' : '#f2f6fa';
}

export function telegramWallpaperBackground(colors: readonly string[], rotation: number = 135) {
  if (colors.length === 0) return '';
  if (colors.length === 1) return colors[0]!;
  if (colors.length === 2) {
    return `linear-gradient(${rotation}deg, ${colors[0]}, ${colors[1]})`;
  }
  const [topLeft, topRight, bottomRight, bottomLeft = colors[0]!] = colors;
  return [
    `radial-gradient(circle at 12% 14%, ${topLeft} 0%, transparent 58%)`,
    `radial-gradient(circle at 88% 12%, ${topRight} 0%, transparent 56%)`,
    `radial-gradient(circle at 86% 88%, ${bottomRight} 0%, transparent 60%)`,
    `linear-gradient(${rotation}deg, ${bottomLeft}, ${topLeft})`,
  ].join(', ');
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function safeColor(value: unknown) {
  const color = typeof value === 'string' ? value : '';
  return colorPattern.test(color) ? color.toLowerCase() : undefined;
}

function normalizeTelegramTheme(value: unknown): TelegramThemePreference | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const accentColor = safeColor(record.accentColor);
  const id = typeof record.id === 'string' ? record.id : '';
  const title = typeof record.title === 'string' ? record.title : '';
  if (!id || !title || !accentColor || !baseThemeIds.has(String(record.baseTheme)))
    return undefined;
  const outboxAccentColor = safeColor(record.outboxAccentColor);
  return {
    id,
    title,
    baseTheme: record.baseTheme as TelegramThemePreference['baseTheme'],
    accentColor,
    ...(outboxAccentColor ? { outboxAccentColor } : {}),
    messageColors: Array.isArray(record.messageColors)
      ? record.messageColors.flatMap((color) => safeColor(color) ?? []).slice(0, 4)
      : [],
  };
}

function normalizeTelegramWallpaper(value: unknown): TelegramWallpaperPreference | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const label = typeof record.label === 'string' ? record.label : '';
  if (!id || !label) return undefined;
  return {
    id,
    label,
    backgroundColors: Array.isArray(record.backgroundColors)
      ? record.backgroundColors.flatMap((color) => safeColor(color) ?? []).slice(0, 4)
      : [],
    rotation: boundedNumber(record.rotation, 135, 0, 360),
    hasFile: Boolean(record.hasFile),
    pattern: Boolean(record.pattern),
    dark: Boolean(record.dark),
    ...(record.intensity !== undefined
      ? { intensity: boundedNumber(record.intensity, 50, -100, 100) }
      : {}),
  };
}

export function normalizeThemePreferences(value: unknown): ThemePreferences {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const telegramTheme = normalizeTelegramTheme(record.telegramTheme);
  const telegramWallpaper = normalizeTelegramWallpaper(record.telegramWallpaper);
  const requestedWallpaper = wallpaperIds.has(String(record.wallpaper))
    ? (record.wallpaper as WallpaperId)
    : DEFAULT_THEME_PREFERENCES.wallpaper;
  return {
    theme: themeIds.has(String(record.theme))
      ? (record.theme as ThemePresetId)
      : record.theme === 'midnight'
        ? 'night'
        : record.theme === 'violet'
          ? 'classic'
          : record.theme === 'telegram' && telegramTheme
            ? 'telegram'
            : DEFAULT_THEME_PREFERENCES.theme,
    accentColor: safeColor(record.accentColor) ?? DEFAULT_THEME_PREFERENCES.accentColor,
    systemAccent: Boolean(record.systemAccent),
    wallpaper:
      requestedWallpaper === 'telegram' && !telegramWallpaper
        ? DEFAULT_THEME_PREFERENCES.wallpaper
        : requestedWallpaper,
    wallpaperBlur: boundedNumber(
      record.wallpaperBlur,
      DEFAULT_THEME_PREFERENCES.wallpaperBlur,
      0,
      20,
    ),
    wallpaperDim: boundedNumber(record.wallpaperDim, DEFAULT_THEME_PREFERENCES.wallpaperDim, 0, 70),
    chatFontSize: boundedNumber(
      record.chatFontSize,
      DEFAULT_THEME_PREFERENCES.chatFontSize,
      MIN_CHAT_FONT_SIZE,
      MAX_CHAT_FONT_SIZE,
    ),
    ...(telegramTheme ? { telegramTheme } : {}),
    ...(telegramWallpaper ? { telegramWallpaper } : {}),
  };
}

export function readThemePreferences(storage: Pick<Storage, 'getItem'> = localStorage) {
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : undefined;
    const normalized = normalizeThemePreferences(parsed);
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as Record<string, unknown>).version !== THEME_PREFERENCES_VERSION &&
      (normalized.wallpaper === 'doodles' ||
        (normalized.wallpaper === 'telegram' && normalized.theme === 'telegram'))
    ) {
      return { ...normalized, wallpaper: 'none' as const };
    }
    return normalized;
  } catch {
    return DEFAULT_THEME_PREFERENCES;
  }
}

export function saveThemePreferences(
  preferences: ThemePreferences,
  storage: Pick<Storage, 'setItem'> = localStorage,
) {
  storage.setItem(
    THEME_STORAGE_KEY,
    JSON.stringify({
      ...normalizeThemePreferences(preferences),
      version: THEME_PREFERENCES_VERSION,
    }),
  );
}

export function applyThemePreferences(
  preferences: ThemePreferences,
  root: HTMLElement = document.documentElement,
) {
  const normalized = normalizeThemePreferences(preferences);
  const baseTheme = normalized.telegramTheme?.baseTheme;
  const resolvedTheme =
    normalized.theme === 'telegram'
      ? baseTheme === 'day' || baseTheme === 'arctic'
        ? 'day'
        : baseTheme === 'tinted'
          ? 'tinted'
          : baseTheme === 'classic'
            ? 'classic'
            : 'night'
      : normalized.theme;
  root.dataset.theme = resolvedTheme;
  root.dataset.themeSource = normalized.theme;
  root.dataset.wallpaper = normalized.wallpaper;
  const wallpaperPattern = normalized.telegramWallpaper?.pattern
    ? normalized.telegramWallpaper.dark ||
      (normalized.telegramWallpaper.intensity ?? 50) < 0 ||
      resolvedTheme === 'night' ||
      resolvedTheme === 'tinted'
      ? 'inverted'
      : 'normal'
    : undefined;
  if (normalized.wallpaper === 'telegram' && wallpaperPattern) {
    root.dataset.wallpaperPattern = wallpaperPattern;
  } else {
    delete root.dataset.wallpaperPattern;
  }
  root.style.setProperty('--wallpaper-blur', `${normalized.wallpaperBlur}px`);
  root.style.setProperty('--wallpaper-dim', `${normalized.wallpaperDim / 100}`);
  root.style.setProperty('--chat-font-size', `${normalized.chatFontSize}px`);
  root.style.setProperty(
    '--chat-font-scale',
    `${normalized.chatFontSize / DEFAULT_CHAT_FONT_SIZE}`,
  );
  root.style.colorScheme =
    resolvedTheme === 'day' || resolvedTheme === 'classic' ? 'light' : 'dark';
  for (const property of ['--accent', '--accent-soft', '--dialog-selected']) {
    root.style.removeProperty(property);
  }
  if (normalized.theme !== 'telegram') {
    const accent = normalized.systemAccent ? 'AccentColor' : normalized.accentColor;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 16%, transparent)`);
    root.style.setProperty('--dialog-selected', `color-mix(in srgb, ${accent} 78%, var(--panel))`);
  }
  for (const property of [
    '--telegram-accent',
    '--telegram-outbox',
    '--telegram-message-1',
    '--telegram-message-2',
    '--telegram-message-text',
    '--telegram-wallpaper-gradient',
    '--telegram-wallpaper-intensity',
  ]) {
    root.style.removeProperty(property);
  }
  if (normalized.theme === 'telegram' && normalized.telegramTheme) {
    const theme = normalized.telegramTheme;
    const outbox = theme.outboxAccentColor ?? theme.accentColor;
    root.style.setProperty('--telegram-accent', theme.accentColor);
    root.style.setProperty('--telegram-outbox', outbox);
    root.style.setProperty('--telegram-message-1', theme.messageColors[0] ?? outbox);
    root.style.setProperty(
      '--telegram-message-2',
      theme.messageColors[1] ?? theme.messageColors[0] ?? outbox,
    );
    root.style.setProperty(
      '--telegram-message-text',
      readableTextColor(theme.messageColors[0] ?? outbox),
    );
  }
  if (normalized.wallpaper === 'telegram' && normalized.telegramWallpaper) {
    const wallpaper = normalized.telegramWallpaper;
    const colors = wallpaper.backgroundColors.length
      ? wallpaper.backgroundColors
      : [
          resolvedTheme === 'day' ? '#dfe7ef' : '#17212b',
          resolvedTheme === 'day' ? '#cbd8e4' : '#223344',
        ];
    root.style.setProperty(
      '--telegram-wallpaper-gradient',
      telegramWallpaperBackground(colors, wallpaper.rotation),
    );
    root.style.setProperty(
      '--telegram-wallpaper-intensity',
      `${Math.abs(wallpaper.intensity ?? 50) / 100}`,
    );
  }
}
