import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  normalizeThemePreferences,
  readThemePreferences,
  saveThemePreferences,
  telegramWallpaperBackground,
} from './themePreferences';

describe('theme preferences', () => {
  it('normalizes unknown values and bounds effects', () => {
    expect(
      normalizeThemePreferences({
        theme: 'unknown',
        wallpaper: 'aurora',
        wallpaperBlur: 99,
        wallpaperDim: -4,
      }),
    ).toEqual({
      theme: 'night',
      accentColor: '#58a8e8',
      systemAccent: false,
      wallpaper: 'aurora',
      wallpaperBlur: 20,
      wallpaperDim: 0,
    });
  });

  it('falls back when storage is corrupt', () => {
    expect(readThemePreferences({ getItem: () => '{broken' })).toEqual(DEFAULT_THEME_PREFERENCES);
  });

  it('removes the old globally assigned doodle background', () => {
    expect(
      readThemePreferences({
        getItem: () =>
          JSON.stringify({
            theme: 'midnight',
            wallpaper: 'doodles',
            wallpaperBlur: 0,
            wallpaperDim: 18,
          }),
      }),
    ).toEqual({
      theme: 'night',
      accentColor: '#58a8e8',
      systemAccent: false,
      wallpaper: 'none',
      wallpaperBlur: 0,
      wallpaperDim: 18,
    });
  });

  it('saves a normalized value', () => {
    let savedKey = '';
    let savedValue = '';
    saveThemePreferences(
      {
        theme: 'day',
        accentColor: '#4fa45f',
        systemAccent: false,
        wallpaper: 'sunset',
        wallpaperBlur: 4,
        wallpaperDim: 24,
      },
      {
        setItem(key, value) {
          savedKey = key;
          savedValue = value;
        },
      },
    );
    expect(savedKey).toBe(THEME_STORAGE_KEY);
    expect(JSON.parse(savedValue)).toEqual({
      theme: 'day',
      accentColor: '#4fa45f',
      systemAccent: false,
      wallpaper: 'sunset',
      wallpaperBlur: 4,
      wallpaperDim: 24,
      version: 5,
    });
  });

  it('renders Telegram multi-color backgrounds as freeform gradients', () => {
    const background = telegramWallpaperBackground(['#111111', '#223322', '#334433'], 90);
    expect(background).toContain('radial-gradient(circle at 12% 14%');
    expect(background).toContain('radial-gradient(circle at 88% 12%');
    expect(background).toContain('linear-gradient(90deg');
  });

  it('removes wallpapers that old versions attached implicitly to Telegram themes', () => {
    expect(
      readThemePreferences({
        getItem: () =>
          JSON.stringify({
            version: 4,
            theme: 'telegram',
            telegramTheme: {
              id: 'theme-1',
              title: 'Theme',
              baseTheme: 'night',
              accentColor: '#58a8e8',
              messageColors: ['#223549'],
            },
            wallpaper: 'telegram',
            telegramWallpaper: {
              id: 'wallpaper-1',
              label: 'Wallpaper',
              backgroundColors: ['#111111', '#223322'],
              rotation: 135,
              hasFile: false,
              pattern: false,
              dark: true,
            },
          }),
      }).wallpaper,
    ).toBe('none');
  });
});
