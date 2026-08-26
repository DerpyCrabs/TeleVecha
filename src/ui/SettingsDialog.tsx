import LogOut from 'lucide-solid/icons/log-out';
import Settings from 'lucide-solid/icons/settings';
import X from 'lucide-solid/icons/x';
import { Portal } from 'solid-js/web';

import { useModalDialog } from './useModalDialog';

export function SettingsDialog(props: {
  loggingOut: boolean;
  close: () => void;
  logOut: () => void;
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
          event.target === event.currentTarget && !props.loggingOut && props.close()
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
          <div class="settings-section">
            <div>
              <strong>Telegram account</strong>
              <p>
                Signing out removes the session, cached chats, drafts, media, and queued sends from
                this browser.
              </p>
            </div>
            <button
              class="settings-danger-action"
              disabled={props.loggingOut}
              onClick={props.logOut}
            >
              <LogOut size={17} />
              {props.loggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </section>
      </div>
    </Portal>
  );
}
