import { list } from 'effectweb';
import type { TelegramUrlAuthAcceptOptions, TelegramUrlAuthResult } from '../../telegram/types';
import X from '@effectweb/lucide/icons/x';
import { collection, component, Portal, view } from 'effectweb';
import { modalMount } from '../shared/modalMount';
const codeRows = collection<string>((code) => code).from;
type UrlAuthRequest = Extract<TelegramUrlAuthResult, { kind: 'request' }>;
interface BotUrlAuthDialogProps {
  request: UrlAuthRequest;
  busy: boolean;
  close: () => void;
  confirm: (options: TelegramUrlAuthAcceptOptions) => void;
}
type BotUrlAuthDialogState = {
  writeAllowed: boolean;
  sharePhoneNumber: boolean;
  matchCode: string;
};
type BotUrlAuthDialogMessage =
  | { type: 'WriteAllowed'; value: boolean }
  | { type: 'SharePhoneNumber'; value: boolean }
  | { type: 'MatchCode'; value: string };
export const BotUrlAuthDialog = component<
  BotUrlAuthDialogProps,
  BotUrlAuthDialogState,
  BotUrlAuthDialogMessage
>(
  {
    init: () => ({ writeAllowed: false, sharePhoneNumber: false, matchCode: '' }),
    update: (model, message) => {
      switch (message.type) {
        case 'WriteAllowed':
          return { model: { ...model, writeAllowed: message.value } };
        case 'SharePhoneNumber':
          return { model: { ...model, sharePhoneNumber: message.value } };
        case 'MatchCode':
          return { model: { ...model, matchCode: message.value } };
      }
    },
  },
  view((model, send) => {
    const props = model.props;
    const close = () => {
      if (!props.busy) props.close();
    };
    return (
      <Portal>
        <div
          use={modalMount(close)}
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
              <button
                type="button"
                disabled={props.busy}
                onClick={close}
                aria-label="Close sign-in"
              >
                <X size={18} />
              </button>
            </header>
            <p id="bot-url-auth-description">
              Continue to <strong>{props.request.domain}</strong>. Only grant the optional
              permissions you want to share.
            </p>
            {props.request.verifiedAppName
              ? ((name) => <p class="bot-url-auth-verified">Verified app: {name}</p>)(
                  props.request.verifiedAppName!,
                )
              : null}
            {props.request.matchCodes?.length ? (
              <fieldset class="bot-url-auth-codes">
                <legend>Verification code</legend>
                {list(codeRows(props.request.matchCodes), (code) => (
                  <label>
                    <input
                      type="radio"
                      name="bot-url-auth-code"
                      value={code}
                      checked={model.matchCode === code}
                      onChange={() => send({ type: 'MatchCode', value: code })}
                    />
                    <span>{code}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <div class="bot-url-auth-permissions">
              {props.request.requestWriteAccess ? (
                <label>
                  <input
                    type="checkbox"
                    checked={model.writeAllowed}
                    onChange={(event) =>
                      send({ type: 'WriteAllowed', value: event.currentTarget.checked })
                    }
                  />
                  <span>Allow {props.request.botTitle} to send me messages</span>
                </label>
              ) : null}
              {props.request.requestPhoneNumber ? (
                <label>
                  <input
                    type="checkbox"
                    checked={model.sharePhoneNumber}
                    onChange={(event) =>
                      send({ type: 'SharePhoneNumber', value: event.currentTarget.checked })
                    }
                  />
                  <span>Share my Telegram phone number</span>
                </label>
              ) : null}
            </div>
            <footer>
              <button type="button" disabled={props.busy} onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                class="primary"
                disabled={
                  props.busy || Boolean(props.request.matchCodes?.length && !model.matchCode)
                }
                onClick={() =>
                  props.confirm({
                    ...(props.request.requestWriteAccess
                      ? { writeAllowed: model.writeAllowed }
                      : {}),
                    ...(props.request.requestPhoneNumber
                      ? { sharePhoneNumber: model.sharePhoneNumber }
                      : {}),
                    ...(model.matchCode ? { matchCode: model.matchCode } : {}),
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
  }),
);
