import { component, domBinding, list, view } from 'effectweb';
import CheckCheck from '@effectweb/lucide/icons/check-check';
import { activateFocusScope } from '../shared/focusScope';
import { Effect } from 'effect';
import type { TelegramMessage } from '../../telegram/types';

type Kind = 'mention' | 'reaction';
interface Props {
  peerId: string;
  mentions: number;
  reactions: number;
  online: boolean;
  load: (kind: Kind) => Effect.Effect<TelegramMessage[], unknown>;
  markAll: () => Effect.Effect<unknown, unknown>;
  open: (message: TelegramMessage) => Promise<unknown>;
}
interface State {
  peerId: string;
  busy: Kind | 'all' | undefined;
  menu: boolean;
  error: string;
}
type Message =
  | { type: 'Open'; kind: Kind }
  | { type: 'MarkAll' }
  | { type: 'Menu'; open: boolean }
  | { type: 'Finished'; error: string };
function acquireNotificationMenu(root: HTMLElement, input: () => () => void) {
  const release = activateFocusScope({ root, close: () => input()(), modal: false });
  const dismiss = (event: PointerEvent) => {
    if (event.target instanceof Node && !root.parentElement?.contains(event.target)) input()();
  };
  document.addEventListener('pointerdown', dismiss);
  return () => {
    release();
    document.removeEventListener('pointerdown', dismiss);
  };
}
const notificationMenu = (close: () => void) => domBinding(close, acquireNotificationMenu);

function acquireNotificationPress(root: HTMLButtonElement, input: () => () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pressed = false;
  let origin: { x: number; y: number } | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    origin = undefined;
  };
  const down = (event: PointerEvent) => {
    cancel();
    pressed = false;
    if (event.pointerType !== 'touch' || root.disabled) return;
    origin = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      pressed = true;
      input()();
    }, 500);
  };
  const move = (event: PointerEvent) => {
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancel();
  };
  const click = (event: MouseEvent) => {
    if (pressed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      pressed = false;
    }
  };
  root.addEventListener('pointerdown', down);
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerup', cancel);
  root.addEventListener('pointercancel', cancel);
  root.addEventListener('click', click, true);
  return () => {
    cancel();
    root.removeEventListener('pointerdown', down);
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerup', cancel);
    root.removeEventListener('pointercancel', cancel);
    root.removeEventListener('click', click, true);
  };
}
const notificationPress = (open: () => void) => domBinding(open, acquireNotificationPress);

export const UnreadNotifications = component<Props, State, Message>(
  {
    init: (props) => ({ peerId: props.peerId, busy: undefined, menu: false, error: '' }),
    receive: (model) =>
      model.peerId === model.props.peerId
        ? { model }
        : {
            model: {
              ...model,
              peerId: model.props.peerId,
              busy: undefined,
              menu: false,
              error: '',
            },
            cancel: [['notification', model.peerId]],
          },
    update: (model, message) => {
      if (message.type === 'Menu') return { model: { ...model, menu: message.open } };
      if (message.type === 'Finished')
        return { model: { ...model, busy: undefined, error: message.error } };
      if (model.busy) return { model };
      const props = model.props;
      return {
        model: {
          ...model,
          busy: message.type === 'MarkAll' ? 'all' : message.kind,
          menu: false,
          error: '',
        },
        commands: [
          {
            key: ['notification', props.peerId],
            policy: 'replace',
            effect: (message.type === 'MarkAll'
              ? props.markAll()
              : props.load(message.kind).pipe(
                  Effect.flatMap((messages) => {
                    const target = messages.slice().sort((left, right) => left.id - right.id)[0];
                    return target
                      ? Effect.tryPromise({
                          try: () => props.open(target),
                          catch: (error) => error,
                        })
                      : Effect.void;
                  }),
                )
            ).pipe(
              Effect.matchCause({
                onSuccess: () => ({ type: 'Finished', error: '' }) as const,
                onFailure: () =>
                  ({
                    type: 'Finished',
                    error:
                      message.type === 'MarkAll'
                        ? 'Could not mark all as read. Try again.'
                        : 'Could not open the notification. Try again.',
                  }) as const,
              }),
            ),
          },
        ],
      };
    },
  },
  view((model, send) => (
    <div class="unread-notifications" role="group" aria-label="Unread replies and reactions">
      {model.error ? (
        <p role="alert" class="max-w-60 rounded-xl border border-line bg-panel p-3 text-sm">
          {model.error}
        </p>
      ) : null}
      {model.menu ? (
        <div
          class="notification-menu"
          role="menu"
          aria-label="Notification options"
          use={notificationMenu(() => send({ type: 'Menu', open: false }))}
        >
          <button type="button" role="menuitem" onClick={() => send({ type: 'MarkAll' })}>
            <CheckCheck size={18} />
            <span>Mark all as read</span>
          </button>
        </div>
      ) : null}
      {list(['mention', 'reaction'] as const, (kind) => {
        const count = kind === 'mention' ? model.props.mentions : model.props.reactions;
        const label = kind === 'mention' ? 'Unread replies and mentions' : 'Unread reactions';
        return count > 0 ? (
          <button
            type="button"
            class="unread-notification-button"
            title={`${label}: ${count}. Go to message`}
            aria-label={`${label}: ${count}. Go to message`}
            disabled={!model.props.online || Boolean(model.busy)}
            aria-busy={model.busy === kind}
            aria-haspopup="menu"
            aria-expanded={model.menu}
            use={notificationPress(() => send({ type: 'Menu', open: true }))}
            onKeyDown={(event) => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault();
                send({ type: 'Menu', open: true });
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              send({ type: 'Menu', open: true });
            }}
            onClick={() => send({ type: 'Open', kind })}
          >
            <span aria-hidden="true" class="text-lg">
              {kind === 'mention' ? '@' : '♡'}
            </span>
            <span class="text-xs font-semibold">{count > 999 ? '999+' : count}</span>
          </button>
        ) : null;
      })}
    </div>
  )),
);
