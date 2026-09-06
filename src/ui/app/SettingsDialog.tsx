import type { TelegramWallpaper } from '../../telegram/types';
import Bug from '@effectweb/lucide/icons/bug';
import Download from '@effectweb/lucide/icons/download';
import LogOut from '@effectweb/lucide/icons/log-out';
import RotateCcw from '@effectweb/lucide/icons/rotate-ccw';
import Settings from '@effectweb/lucide/icons/settings';
import X from '@effectweb/lucide/icons/x';
import { Portal, view } from 'effectweb';
import { modalMount } from '../shared/modalMount';
import { panelCloseButtonClass, panelHeaderClass } from '../shared/panelStyles';
import { AppearanceSettings } from '../theme/AppearanceSettings';
import type { ThemePreferences, ThemePresetId } from '../theme/themePreferences';
export const SettingsDialog = view<
  {
    loggingOut: boolean;
    clearingCache: boolean;
    debugReportBusy: boolean;
    debugReportError: string;
    close: () => void;
    clearCache: () => void;
    downloadDebugReport?: (() => void) | undefined;
    logOut: () => void;
    appearance: ThemePreferences;
    telegramWallpapers: TelegramWallpaper[];
    wallpaperBusy: boolean;
    wallpaperError: string;
    setTheme: (theme: ThemePresetId) => void;
    setAccentColor: (color: string) => void;
    setSystemAccent: (enabled: boolean) => void;
    setChatFontSize: (size: number) => void;
    setWallpaper: (wallpaper: ThemePreferences['wallpaper']) => void;
    setTelegramWallpaper: (wallpaper: TelegramWallpaper) => void;
    setWallpaperEffects: (
      effects: Pick<ThemePreferences, 'wallpaperBlur' | 'wallpaperDim'>,
    ) => void;
    uploadWallpaper: (file: File) => void;
  },
  never
>((props, _send) => {
  return (
    <Portal>
      <div
        use={modalMount(props.close)}
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
          class="settings-dialog flex w-[min(42rem,calc(100vw-2rem))] max-h-[min(48rem,calc(100dvh-2rem))] flex-col overflow-hidden rounded-2xl border border-[var(--line-strong)] bg-panel shadow-[0_24px_80px_var(--shadow)]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
        >
          <header class={panelHeaderClass}>
            <span class="flex items-center gap-[0.55rem]">
              <Settings size={18} />
              <strong id="settings-title">Settings</strong>
            </span>
            <button
              class={panelCloseButtonClass}
              disabled={props.loggingOut}
              onClick={props.close}
              aria-label="Close settings"
            >
              <X size={18} />
            </button>
          </header>
          <div class="settings-dialog-content scroll-area min-h-0 overflow-y-auto overscroll-contain">
            <AppearanceSettings
              preferences={props.appearance}
              telegramWallpapers={props.telegramWallpapers}
              wallpaperBusy={props.wallpaperBusy}
              wallpaperError={props.wallpaperError}
              setTheme={props.setTheme}
              setAccentColor={props.setAccentColor}
              setSystemAccent={props.setSystemAccent}
              setChatFontSize={props.setChatFontSize}
              setWallpaper={props.setWallpaper}
              setTelegramWallpaper={props.setTelegramWallpaper}
              setEffects={props.setWallpaperEffects}
              uploadWallpaper={props.uploadWallpaper}
            />
            {props.downloadDebugReport
              ? ((downloadDebugReport) => (
                  <div class="settings-section flex items-center justify-between gap-4 p-4 [&_p]:mt-[0.35rem] [&_p]:mb-0 [&_p]:max-w-80 [&_p]:text-[0.78rem] [&_p]:leading-[1.2rem] [&_p]:text-muted">
                    <div>
                      <strong class="flex items-center gap-2">
                        <Bug size={17} /> Debug report
                      </strong>
                      <p>
                        Download a compact snapshot of the current problem. Message text is replaced
                        with generated text of the same length. Login data and media files are
                        excluded.
                      </p>
                      {props.debugReportError ? (
                        <p class="text-red-300" role="alert">
                          {props.debugReportError}
                        </p>
                      ) : null}
                    </div>
                    <button
                      class="settings-cache-action flex shrink-0 items-center gap-[0.45rem] rounded-[0.6rem] border border-blue-400/25 bg-blue-800/15 px-3 py-[0.6rem] text-blue-300 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={props.loggingOut || props.clearingCache || props.debugReportBusy}
                      onClick={downloadDebugReport}
                    >
                      <Download size={17} />
                      {props.debugReportBusy ? 'Preparing…' : 'Download report'}
                    </button>
                  </div>
                ))(props.downloadDebugReport!)
              : null}
            <div class="settings-section flex items-center justify-between gap-4 p-4 [&_p]:mt-[0.35rem] [&_p]:mb-0 [&_p]:max-w-76 [&_p]:text-[0.78rem] [&_p]:leading-[1.2rem] [&_p]:text-muted">
              <div>
                <strong>Local cache</strong>
                <p>
                  Clear cached chats, messages, avatars, and media, then download current data from
                  Telegram again. Drafts, queued sends, and your session are kept.
                </p>
              </div>
              <button
                class="settings-cache-action flex shrink-0 items-center gap-[0.45rem] rounded-[0.6rem] border border-blue-400/25 bg-blue-800/15 px-3 py-[0.6rem] text-blue-300 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={props.loggingOut || props.clearingCache}
                onClick={props.clearCache}
              >
                <RotateCcw size={17} />
                {props.clearingCache ? 'Clearing…' : 'Clear cache'}
              </button>
            </div>
            <div class="settings-section flex items-center justify-between gap-4 border-t border-line p-4 [&_p]:mt-[0.35rem] [&_p]:mb-0 [&_p]:max-w-76 [&_p]:text-[0.78rem] [&_p]:leading-[1.2rem] [&_p]:text-muted">
              <div>
                <strong>Telegram account</strong>
                <p>
                  Signing out removes the session, cached chats, drafts, media, and queued sends
                  from this browser.
                </p>
              </div>
              <button
                class="settings-danger-action flex shrink-0 items-center gap-[0.45rem] rounded-[0.6rem] border border-red-400/25 bg-red-900/15 px-3 py-[0.6rem] text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
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
});
