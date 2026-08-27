import LogOut from 'lucide-solid/icons/log-out';
import RotateCcw from 'lucide-solid/icons/rotate-ccw';
import Settings from 'lucide-solid/icons/settings';
import X from 'lucide-solid/icons/x';
import { Portal } from 'solid-js/web';

import type { TelegramWallpaper } from '../../telegram/types';
import { useModalDialog } from '../shared/useModalDialog';
import { AppearanceSettings } from '../theme/AppearanceSettings';
import type { ThemePreferences, ThemePresetId } from '../theme/themePreferences';

export function SettingsDialog(props: {
  loggingOut: boolean;
  clearingCache: boolean;
  close: () => void;
  clearCache: () => void;
  logOut: () => void;
  appearance: ThemePreferences;
  telegramWallpapers: TelegramWallpaper[];
  wallpaperBusy: boolean;
  wallpaperError: string;
  setTheme: (theme: ThemePresetId) => void;
  setAccentColor: (color: string) => void;
  setSystemAccent: (enabled: boolean) => void;
  setWallpaper: (wallpaper: ThemePreferences['wallpaper']) => void;
  setTelegramWallpaper: (wallpaper: TelegramWallpaper) => void;
  setWallpaperEffects: (effects: Pick<ThemePreferences, 'wallpaperBlur' | 'wallpaperDim'>) => void;
  uploadWallpaper: (file: File) => void;
}) {
  let overlay: HTMLDivElement | undefined;
  useModalDialog(() => overlay, props.close);

  return (
    <Portal>
      <div
        ref={(element) => (overlay = element)}
        class="panel-overlay"
        role="presentation"
        tabIndex={-1}
        onPointerDown={(event) =>
          event.target === event.currentTarget &&
          !props.loggingOut &&
          !props.clearingCache &&
          props.close()
        }
      >
        <section
          class="settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
        >
          <header>
            <span>
              <Settings size={18} />
              <strong id="settings-title">Settings</strong>
            </span>
            <button disabled={props.loggingOut} onClick={props.close} aria-label="Close settings">
              <X size={18} />
            </button>
          </header>
          <div class="settings-dialog-content scroll-area">
            <AppearanceSettings
              preferences={props.appearance}
              telegramWallpapers={props.telegramWallpapers}
              wallpaperBusy={props.wallpaperBusy}
              wallpaperError={props.wallpaperError}
              setTheme={props.setTheme}
              setAccentColor={props.setAccentColor}
              setSystemAccent={props.setSystemAccent}
              setWallpaper={props.setWallpaper}
              setTelegramWallpaper={props.setTelegramWallpaper}
              setEffects={props.setWallpaperEffects}
              uploadWallpaper={props.uploadWallpaper}
            />
            <div class="settings-section">
              <div>
                <strong>Local cache</strong>
                <p>
                  Clear cached chats, messages, avatars, and media, then download current data from
                  Telegram again. Drafts, queued sends, and your session are kept.
                </p>
              </div>
              <button
                class="settings-cache-action"
                disabled={props.loggingOut || props.clearingCache}
                onClick={props.clearCache}
              >
                <RotateCcw size={17} />
                {props.clearingCache ? 'Clearing…' : 'Clear cache'}
              </button>
            </div>
            <div class="settings-section">
              <div>
                <strong>Telegram account</strong>
                <p>
                  Signing out removes the session, cached chats, drafts, media, and queued sends
                  from this browser.
                </p>
              </div>
              <button
                class="settings-danger-action"
                disabled={props.loggingOut || props.clearingCache}
                onClick={props.logOut}
              >
                <LogOut size={17} />
                {props.loggingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </Portal>
  );
}
