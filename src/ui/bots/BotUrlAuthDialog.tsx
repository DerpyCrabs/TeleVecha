import X from 'lucide-solid/icons/x';
import { For, Show, createEffect, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';

import type { TelegramUrlAuthAcceptOptions, TelegramUrlAuthResult } from '../../telegram/types';
import { useModalDialog } from '../shared/useModalDialog';

type UrlAuthRequest = Extract<TelegramUrlAuthResult, { kind: 'request' }>;

interface BotUrlAuthDialogProps {
  request: UrlAuthRequest;
  busy: boolean;
  close: () => void;
  confirm: (options: TelegramUrlAuthAcceptOptions) => void;
}

export function BotUrlAuthDialog(props: BotUrlAuthDialogProps) {
  const [writeAllowed, setWriteAllowed] = createSignal(false);
  const [sharePhoneNumber, setSharePhoneNumber] = createSignal(false);
  const [matchCode, setMatchCode] = createSignal('');
  let overlay: HTMLDivElement | undefined;
  let previousRequest = props.request;
  createEffect(() => {
    const request = props.request;
    if (request === previousRequest) return;
    previousRequest = request;
    setWriteAllowed(false);
    setSharePhoneNumber(false);
    setMatchCode('');
  });
  const close = () => {
    if (!props.busy) props.close();
  };
  useModalDialog(() => overlay, close);

  return (
    <Portal>
      <div
        ref={(element) => (overlay = element)}
        class="bot-url-auth-overlay"
        tabIndex={-1}
        onPointerDown={(event) => event.target === event.currentTarget && close()}
      >
        <section
          class="bot-url-auth-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bot-url-auth-title"
          aria-describedby="bot-url-auth-description"
        >
          <header>
            <h2 id="bot-url-auth-title">Sign in with {props.request.botTitle}</h2>
            <button type="button" disabled={props.busy} onClick={close} aria-label="Close sign-in">
              <X size={18} />
            </button>
          </header>
          <p id="bot-url-auth-description">
            Continue to <strong>{props.request.domain}</strong>. Only grant the optional permissions
            you want to share.
          </p>
          <Show when={props.request.verifiedAppName}>
            {(name) => <p class="bot-url-auth-verified">Verified app: {name()}</p>}
          </Show>
          <Show when={props.request.matchCodes?.length}>
            <fieldset class="bot-url-auth-codes">
              <legend>Verification code</legend>
              <For each={props.request.matchCodes}>
                {(code) => (
                  <label>
                    <input
                      type="radio"
                      name="bot-url-auth-code"
                      value={code}
                      checked={matchCode() === code}
                      onChange={() => setMatchCode(code)}
                    />
                    <span>{code}</span>
                  </label>
                )}
              </For>
            </fieldset>
          </Show>
          <div class="bot-url-auth-permissions">
            <Show when={props.request.requestWriteAccess}>
              <label>
                <input
                  type="checkbox"
                  checked={writeAllowed()}
                  onChange={(event) => setWriteAllowed(event.currentTarget.checked)}
                />
                <span>Allow {props.request.botTitle} to send me messages</span>
              </label>
            </Show>
            <Show when={props.request.requestPhoneNumber}>
              <label>
                <input
                  type="checkbox"
                  checked={sharePhoneNumber()}
                  onChange={(event) => setSharePhoneNumber(event.currentTarget.checked)}
                />
                <span>Share my Telegram phone number</span>
              </label>
            </Show>
          </div>
          <footer>
            <button type="button" disabled={props.busy} onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              class="primary"
              disabled={props.busy || Boolean(props.request.matchCodes?.length && !matchCode())}
              onClick={() =>
                props.confirm({
                  ...(props.request.requestWriteAccess ? { writeAllowed: writeAllowed() } : {}),
                  ...(props.request.requestPhoneNumber
                    ? { sharePhoneNumber: sharePhoneNumber() }
                    : {}),
                  ...(matchCode() ? { matchCode: matchCode() } : {}),
                })
              }
            >
              {props.busy ? 'Connecting…' : `Continue to ${props.request.domain}`}
            </button>
          </footer>
        </section>
      </div>
    </Portal>
  );
}
