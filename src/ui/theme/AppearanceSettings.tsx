import Check from 'lucide-solid/icons/check';
import CloudDownload from 'lucide-solid/icons/cloud-download';
import Image from 'lucide-solid/icons/image';
import Upload from 'lucide-solid/icons/upload';
import { For, Show } from 'solid-js';

import type { TelegramWallpaper } from '../../telegram/types';
import {
  ACCENT_COLORS,
  THEME_OPTIONS,
  WALLPAPER_OPTIONS,
  MAX_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
  telegramWallpaperBackground,
  type ThemePreferences,
  type ThemePresetId,
} from './themePreferences';

function wallpaperGradient(wallpaper: TelegramWallpaper) {
  const colors = wallpaper.settings.backgroundColors;
  if (!colors.length) return wallpaper.dark ? '#17212b' : '#dfe7ef';
  return telegramWallpaperBackground(colors, wallpaper.settings.rotation ?? 135);
}

export function AppearanceSettings(props: {
  preferences: ThemePreferences;
  telegramWallpapers: TelegramWallpaper[];
  wallpaperBusy: boolean;
  wallpaperError: string;
  setTheme: (theme: ThemePresetId) => void;
  setAccentColor: (color: string) => void;
  setSystemAccent: (enabled: boolean) => void;
  setChatFontSize: (size: number) => void;
  setWallpaper: (wallpaper: ThemePreferences['wallpaper']) => void;
  setTelegramWallpaper: (wallpaper: TelegramWallpaper) => void;
  setEffects: (effects: Pick<ThemePreferences, 'wallpaperBlur' | 'wallpaperDim'>) => void;
  uploadWallpaper: (file: File) => void;
}) {
  let fileInput: HTMLInputElement | undefined;

  return (
    <div class="appearance-settings">
      <section class="appearance-group" aria-labelledby="appearance-theme-title">
        <div class="appearance-heading">
          <div>
            <strong id="appearance-theme-title">Color theme</strong>
            <p>Stored only in TeleVecha. Other Telegram clients are not changed.</p>
          </div>
        </div>
        <div class="desktop-theme-grid">
          <For each={THEME_OPTIONS}>
            {(theme) => (
              <button
                class="desktop-theme-option"
                classList={{ selected: props.preferences.theme === theme.id }}
                aria-pressed={props.preferences.theme === theme.id}
                aria-label={`${theme.label} theme`}
                onClick={() => props.setTheme(theme.id)}
              >
                <span class={`desktop-theme-preview preview-${theme.id}`} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <strong>{theme.label}</strong>
              </button>
            )}
          </For>
        </div>

        <div class="accent-color-list" aria-label="Accent color">
          <For each={ACCENT_COLORS}>
            {(color) => (
              <button
                class="accent-color-option"
                classList={{
                  selected:
                    !props.preferences.systemAccent && props.preferences.accentColor === color,
                }}
                aria-label={`Accent ${color}`}
                aria-pressed={
                  !props.preferences.systemAccent && props.preferences.accentColor === color
                }
                style={{ '--option-accent': color }}
                onClick={() => props.setAccentColor(color)}
              />
            )}
          </For>
        </div>
        <label class="system-accent-option">
          <input
            type="checkbox"
            checked={props.preferences.systemAccent}
            onChange={(event) => props.setSystemAccent(event.currentTarget.checked)}
          />
          <span>System accent color</span>
        </label>
      </section>

      <section class="appearance-group" aria-labelledby="appearance-font-title">
        <div class="appearance-heading">
          <div>
            <strong id="appearance-font-title">Chat font size</strong>
            <p>Changes message text only. The rest of the interface keeps its current size.</p>
          </div>
        </div>
        <label class="grid gap-2">
          <span class="flex items-center justify-between text-xs text-muted">
            Message text <output>{props.preferences.chatFontSize}px</output>
          </span>
          <input
            class="w-full accent-[var(--accent)]"
            type="range"
            aria-label="Chat font size"
            min={MIN_CHAT_FONT_SIZE}
            max={MAX_CHAT_FONT_SIZE}
            step="1"
            value={props.preferences.chatFontSize}
            onInput={(event) => props.setChatFontSize(Number(event.currentTarget.value))}
          />
        </label>
      </section>

      <section class="appearance-group" aria-labelledby="appearance-wallpaper-title">
        <div class="appearance-heading">
          <div>
            <strong id="appearance-wallpaper-title">Chat background</strong>
            <p>Choose a preset, a Telegram background, or your own image.</p>
          </div>
        </div>
        <div class="wallpaper-option-grid">
          <For each={WALLPAPER_OPTIONS}>
            {(wallpaper) => (
              <button
                class={`wallpaper-option wallpaper-${wallpaper.id}`}
                classList={{ selected: props.preferences.wallpaper === wallpaper.id }}
                aria-label={`${wallpaper.label} background`}
                aria-pressed={props.preferences.wallpaper === wallpaper.id}
                onClick={() => props.setWallpaper(wallpaper.id)}
              >
                <span>{wallpaper.label}</span>
                <Show when={props.preferences.wallpaper === wallpaper.id}>
                  <Check size={16} />
                </Show>
              </button>
            )}
          </For>
          <button
            class="wallpaper-option wallpaper-custom"
            classList={{ selected: props.preferences.wallpaper === 'custom' }}
            aria-label="Upload custom background"
            aria-pressed={props.preferences.wallpaper === 'custom'}
            onClick={() => fileInput?.click()}
          >
            <Upload size={18} />
            <span>Upload image</span>
          </button>
          <input
            ref={(element) => (fileInput = element)}
            class="sr-only"
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) props.uploadWallpaper(file);
              event.currentTarget.value = '';
            }}
          />
        </div>

        <Show when={props.telegramWallpapers.length > 0}>
          <div class="telegram-wallpaper-list">
            <For each={props.telegramWallpapers.slice(0, 18)}>
              {(wallpaper, index) => (
                <button
                  class="telegram-wallpaper-option"
                  classList={{
                    selected:
                      props.preferences.wallpaper === 'telegram' &&
                      props.preferences.telegramWallpaper?.id === wallpaper.id,
                  }}
                  aria-label={`Telegram background ${wallpaper.slug || index() + 1}`}
                  aria-pressed={
                    props.preferences.wallpaper === 'telegram' &&
                    props.preferences.telegramWallpaper?.id === wallpaper.id
                  }
                  disabled={props.wallpaperBusy}
                  style={{ background: wallpaperGradient(wallpaper) }}
                  onClick={() => props.setTelegramWallpaper(wallpaper)}
                >
                  <Show when={wallpaper.hasFile} fallback={<Image size={16} />}>
                    <CloudDownload size={16} />
                  </Show>
                  <Show when={props.preferences.telegramWallpaper?.id === wallpaper.id}>
                    <Check size={16} />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.wallpaperError}>
          <p class="appearance-error" role="alert">
            {props.wallpaperError}
          </p>
        </Show>

        <div class="wallpaper-effects">
          <label>
            <span>
              Dim <output>{props.preferences.wallpaperDim}%</output>
            </span>
            <input
              type="range"
              min="0"
              max="70"
              value={props.preferences.wallpaperDim}
              onInput={(event) =>
                props.setEffects({
                  wallpaperDim: Number(event.currentTarget.value),
                  wallpaperBlur: props.preferences.wallpaperBlur,
                })
              }
            />
          </label>
          <label>
            <span>
              Blur <output>{props.preferences.wallpaperBlur}px</output>
            </span>
            <input
              type="range"
              min="0"
              max="20"
              value={props.preferences.wallpaperBlur}
              onInput={(event) =>
                props.setEffects({
                  wallpaperBlur: Number(event.currentTarget.value),
                  wallpaperDim: props.preferences.wallpaperDim,
                })
              }
            />
          </label>
        </div>
      </section>
    </div>
  );
}
