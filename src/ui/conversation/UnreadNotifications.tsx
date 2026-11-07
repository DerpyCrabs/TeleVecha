import { component, list, view } from 'effectweb';
import { Effect } from 'effect';
import type { TelegramMessage } from '../../telegram/types';

type Kind = 'mention' | 'reaction';
interface Props {
  peerId: string;
  mentions: number;
  reactions: number;
  online: boolean;
  load: (kind: Kind) => Effect.Effect<TelegramMessage[], unknown>;
  open: (message: TelegramMessage) => Promise<unknown>;
}
interface State {
  peerId: string;
  busy: Kind | undefined;
  error: string;
}
type Message = { type: 'Open'; kind: Kind } | { type: 'Finished'; error: string };

export const UnreadNotifications = component<Props, State, Message>(
  {
    init: (props) => ({ peerId: props.peerId, busy: undefined, error: '' }),
    receive: (model) =>
      model.peerId === model.props.peerId
        ? { model }
        : {
            model: { ...model, peerId: model.props.peerId, busy: undefined, error: '' },
            cancel: [['notification', model.peerId]],
          },
    update: (model, message) => {
      if (message.type === 'Finished')
        return { model: { ...model, busy: undefined, error: message.error } };
      if (model.busy) return { model };
      const props = model.props;
      return {
        model: { ...model, busy: message.kind, error: '' },
        commands: [
          {
            key: ['notification', props.peerId],
            policy: 'replace',
            effect: props.load(message.kind).pipe(
              Effect.flatMap((messages) => {
                const target = messages.slice().sort((left, right) => left.id - right.id)[0];
                return target
                  ? Effect.tryPromise({ try: () => props.open(target), catch: (error) => error })
                  : Effect.void;
              }),
              Effect.matchCause({
                onSuccess: () => ({ type: 'Finished', error: '' }) as const,
                onFailure: () =>
                  ({
                    type: 'Finished',
                    error: 'Could not open the notification. Try again.',
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
