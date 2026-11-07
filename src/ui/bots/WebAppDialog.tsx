import { component, domBinding, list, view } from 'effectweb';
import { Effect } from 'effect';
import ArrowLeft from '@effectweb/lucide/icons/arrow-left';
import { Dialog } from '../shared/Dialog';
import { connectWebApp, miniAppTheme, webAppFrameUrl, type WebAppEvent } from './webAppBridge';
import { validWebAppData } from '../../domain/webApp';
import { safeExternalUrl } from '../shared/safeUrl';
import type {
  TelegramPeer,
  TelegramWebApp,
  TelegramWebAppRequest,
  TelegramBotAppInfo,
} from '../../telegram/types';
import { idRows } from '../collections';
export interface WebAppApi {
  getBotApp(bot: TelegramPeer, shortName: string): Effect.Effect<TelegramBotAppInfo, unknown>;
  requestWebApp(request: TelegramWebAppRequest): Effect.Effect<TelegramWebApp, unknown>;
  prolongWebApp(
    peer: TelegramPeer,
    bot: TelegramPeer,
    queryId: string,
  ): Effect.Effect<void, unknown>;
  sendWebAppData(bot: TelegramPeer, text: string, data: string): Effect.Effect<void, unknown>;
  invokeWebAppMethod(
    bot: TelegramPeer,
    method: string,
    params: string,
  ): Effect.Effect<string, unknown>;
}
export interface OpenWebApp {
  app: TelegramWebApp;
  request: TelegramWebAppRequest;
  title: string;
  buttonText: string;
  sameOrigin: boolean;
}
interface Props {
  pending: OpenWebApp;
  api: WebAppApi;
  close: () => void;
}
interface Button {
  visible: boolean;
  active: boolean;
  text: string;
  progress: boolean;
}
interface Popup {
  title: string;
  message: string;
  buttons: { id: string; buttonId: string; text: string }[];
}
const invisibleButton: Button = { visible: false, active: true, text: '', progress: false };
const notice = (error: unknown) =>
  error instanceof Error ? error.message : 'The Mini App action failed.';
export const WebAppDialog = component(
  {
    identity: (props: Props) => props.pending.app.url,
    init: (_props: Props) => ({
      back: false,
      main: invisibleButton,
      closingConfirmation: false,
      confirmClose: false,
      popup: undefined as Popup | undefined,
      external: undefined as string | undefined,
      outgoing: [] as { sequence: number; event: WebAppEvent }[],
      sequence: 0,
      sentData: false,
      busy: false,
      error: '',
    }),
  },
  (owner) =>
    view((model) => {
      const { pending, api } = model.props;
      const send = (eventType: string, eventData?: unknown) => {
        const sequence = owner.read().sequence + 1;
        owner.patch({
          sequence,
          outgoing: [...owner.read().outgoing, { sequence, event: { eventType, eventData } }],
        });
      };
      const close = () => {
        if (owner.read().busy) return;
        if (owner.read().closingConfirmation) owner.patch({ confirmClose: true });
        else model.props.close();
      };
      const viewport = () =>
        send('viewport_changed', {
          height: document.querySelector('.mini-app-frame')?.clientHeight ?? window.innerHeight,
          is_state_stable: true,
          is_expanded: true,
        });
      const receive = ({
        eventType,
        eventData: data,
      }: {
        eventType: string;
        eventData: Record<string, unknown>;
      }) => {
        switch (eventType) {
          case 'web_app_ready':
          case 'web_app_request_viewport':
          case 'web_app_expand':
            viewport();
            break;
          case 'web_app_request_theme':
            send('theme_changed', { theme_params: miniAppTheme() });
            break;
          case 'web_app_setup_back_button':
            owner.patch({ back: data.is_visible === true });
            break;
          case 'web_app_setup_closing_behavior':
            owner.patch({ closingConfirmation: data.need_confirmation === true });
            break;
          case 'web_app_setup_main_button':
            owner.patch({
              main: {
                visible:
                  data.is_visible === true && typeof data.text === 'string' && !!data.text.trim(),
                active: data.is_active !== false,
                text: typeof data.text === 'string' ? data.text.slice(0, 128) : '',
                progress: data.is_progress_visible === true,
              },
            });
            break;
          case 'web_app_close':
            close();
            break;
          case 'web_app_open_link': {
            const url = typeof data.url === 'string' ? safeExternalUrl(data.url) : undefined;
            if (url) owner.patch({ external: url });
            break;
          }
          case 'web_app_open_tg_link': {
            if (
              typeof data.path_full === 'string' &&
              data.path_full.startsWith('/') &&
              !data.path_full.startsWith('//')
            )
              owner.patch({ external: `https://t.me${data.path_full}` });
            break;
          }
          case 'web_app_open_popup': {
            if (owner.read().popup || typeof data.message !== 'string') return;
            const buttons = Array.isArray(data.buttons)
              ? data.buttons.slice(0, 3).flatMap((raw: unknown, index: number) => {
                  if (!raw || typeof raw !== 'object') return [];
                  const button = raw as Record<string, unknown>;
                  if (button.id !== undefined && typeof button.id !== 'string') return [];
                  return [
                    {
                      id: String(index),
                      buttonId: typeof button.id === 'string' ? button.id : '',
                      text:
                        typeof button.text === 'string'
                          ? button.text.slice(0, 64)
                          : button.type === 'cancel'
                            ? 'Cancel'
                            : button.type === 'close'
                              ? 'Close'
                              : 'OK',
                    },
                  ];
                })
              : [];
            owner.patch({
              popup: {
                title: typeof data.title === 'string' ? data.title.slice(0, 64) : pending.title,
                message: data.message.slice(0, 256),
                buttons: buttons.length ? buttons : [{ id: '0', buttonId: '', text: 'OK' }],
              },
            });
            break;
          }
          case 'web_app_data_send': {
            if (
              pending.request.mode !== 'simple' ||
              owner.read().sentData ||
              typeof data.data !== 'string' ||
              !validWebAppData(data.data)
            )
              return;
            owner.patch({ sentData: true, busy: true });
            owner.run(
              'send-data',
              api
                .sendWebAppData(pending.request.bot, pending.buttonText, data.data)
                .pipe(
                  Effect.match({
                    onSuccess: model.props.close,
                    onFailure: (error) => owner.patch({ busy: false, error: notice(error) }),
                  }),
                ),
              'drop',
            );
            break;
          }
          case 'web_app_invoke_custom_method': {
            if (
              typeof data.req_id !== 'string' ||
              typeof data.method !== 'string' ||
              !data.params ||
              typeof data.params !== 'object'
            )
              return;
            const reqId = data.req_id;
            owner.run(
              ['custom-method', reqId],
              api
                .invokeWebAppMethod(pending.request.bot, data.method, JSON.stringify(data.params))
                .pipe(
                  Effect.match({
                    onSuccess: (result) => {
                      try {
                        const decoded: unknown = JSON.parse(result);
                        send('custom_method_invoked', { req_id: reqId, result: decoded });
                      } catch {
                        send('custom_method_invoked', { req_id: reqId, error: 'INVALID_RESPONSE' });
                      }
                    },
                    onFailure: (error) =>
                      send('custom_method_invoked', { req_id: reqId, error: notice(error) }),
                  }),
                ),
              'drop',
            );
            break;
          }
          case 'web_app_open_scan_qr_popup':
            send('scan_qr_popup_closed');
            break;
          case 'web_app_request_write_access':
            send('write_access_requested', { status: 'cancelled' });
            break;
          case 'web_app_request_phone':
            send('phone_requested', { status: 'cancelled' });
            break;
          case 'web_app_read_text_from_clipboard':
            send('clipboard_text_received', { req_id: data.req_id });
            break;
          case 'web_app_open_invoice':
            send('invoice_closed', { slug: data.slug, status: 'cancelled' });
            owner.patch({ error: 'Payments are not supported in this client yet.' });
            break;
        }
      };
      const onMount = () => {
        if (!pending.app.queryId || !['inline', 'menu'].includes(pending.request.mode))
          return Effect.void;
        return Effect.forever(
          Effect.sleep(60_000).pipe(
            Effect.andThen(
              api.prolongWebApp(pending.request.peer, pending.request.bot, pending.app.queryId),
            ),
          ),
        ).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              if (notice(error).includes('QUERY_ID_INVALID')) model.props.close();
              else owner.patch({ error: 'The Mini App connection was interrupted.' });
            }),
          ),
        );
      };
      // The lifetime belongs to the dialog, not to rerenders of its controls.
      const frameUrl = webAppFrameUrl(pending.app.url, pending.request.theme);
      return (
        <Dialog
          title={pending.title}
          closeLabel="Close Mini App"
          onClose={close}
          headerLeading={
            model.back ? (
              <button
                class="mini-app-back"
                aria-label="Back in Mini App"
                title="Back"
                onClick={() => send('back_button_pressed')}
              >
                <ArrowLeft size={20} />
              </button>
            ) : undefined
          }
          class={`mini-app-dialog${pending.app.fullscreen || pending.request.displayMode === 'fullscreen' ? ' mini-app-dialog-fullscreen' : pending.request.displayMode === 'compact' ? ' mini-app-dialog-compact' : ''}`}
        >
          <div use={domBinding(onMount, keepWebAppAlive)} class="mini-app-body">
            <iframe
              class="mini-app-frame"
              title={pending.title}
              src={frameUrl}
              sandbox={
                pending.sameOrigin
                  ? 'allow-scripts allow-forms'
                  : 'allow-scripts allow-same-origin allow-forms'
              }
              referrerpolicy="no-referrer"
              use={domBinding(
                {
                  url: pending.app.url,
                  outgoing: model.outgoing,
                  acknowledged: (sequence) =>
                    owner.patch({
                      outgoing: owner.read().outgoing.filter((entry) => entry.sequence > sequence),
                    }),
                  receive,
                },
                connectWebApp,
              )}
            />
            {model.error ? (
              <p class="mini-app-error" role="alert">
                {model.error}
              </p>
            ) : null}
            {model.main.visible ? (
              <button
                class="mini-app-main"
                disabled={!model.main.active || model.busy}
                onClick={() => send('main_button_pressed')}
              >
                {model.main.progress ? '…' : model.main.text}
              </button>
            ) : null}
          </div>
          {model.confirmClose ? (
            <Dialog
              title="Close Mini App?"
              closeLabel="Keep Mini App open"
              onClose={() => owner.patch({ confirmClose: false })}
            >
              <p class="p-5">Your unsaved changes may be lost.</p>
              <div class="mini-app-actions">
                <button onClick={() => owner.patch({ confirmClose: false })}>Cancel</button>
                <button onClick={model.props.close}>Close</button>
              </div>
            </Dialog>
          ) : null}
          {model.external ? (
            <Dialog
              title="Open link?"
              closeLabel="Cancel opening link"
              onClose={() => owner.patch({ external: undefined })}
            >
              <p class="mini-app-link">{model.external}</p>
              <div class="mini-app-actions">
                <button onClick={() => owner.patch({ external: undefined })}>Cancel</button>
                <a
                  href={model.external}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => owner.patch({ external: undefined })}
                >
                  Open
                </a>
              </div>
            </Dialog>
          ) : null}
          {model.popup ? (
            <Dialog
              title={model.popup.title}
              closeLabel="Close popup"
              onClose={() => {
                owner.patch({ popup: undefined });
                send('popup_closed', {});
              }}
            >
              <p class="p-5">{model.popup.message}</p>
              <div class="mini-app-actions">
                {list(idRows(model.popup.buttons), (button) => (
                  <button
                    onClick={() => {
                      owner.patch({ popup: undefined });
                      send('popup_closed', { button_id: button.buttonId });
                    }}
                  >
                    {button.text}
                  </button>
                ))}
              </div>
            </Dialog>
          ) : null}
        </Dialog>
      );
    }),
);
function keepWebAppAlive(_element: HTMLElement, input: () => () => Effect.Effect<void>) {
  return input()();
}
