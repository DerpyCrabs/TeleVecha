import { component, domBinding, list, view, type Send } from 'effectweb';
import { Effect } from 'effect';
import Monitor from '@effectweb/lucide/icons/monitor';
import Smartphone from '@effectweb/lucide/icons/smartphone';
import Globe from '@effectweb/lucide/icons/globe';
import LogOut from '@effectweb/lucide/icons/log-out';
import type { TelegramActiveSession, TelegramActiveSessions } from '../../telegram/types';
import { idRows } from '../collections';
import { Dialog } from '../shared/Dialog';

export interface SessionsApi {
  getActiveSessions: () => Effect.Effect<TelegramActiveSessions, unknown>;
  terminateSession: (hash?: string) => Effect.Effect<unknown, unknown>;
  setSessionTtl: (days: number) => Effect.Effect<unknown, unknown>;
}
interface Props {
  api: SessionsApi;
  online: boolean;
}
interface State {
  page: TelegramActiveSessions | undefined;
  busy: boolean;
  error: string;
  confirm: string | undefined;
}
type Message =
  | { type: 'Load' }
  | { type: 'Confirm'; id: string | undefined }
  | { type: 'Terminate' }
  | { type: 'Ttl'; days: number }
  | { type: 'Loaded'; page: TelegramActiveSessions }
  | { type: 'Failed'; error: string };
function acquireSessions(_element: HTMLElement, input: () => Send<Message>) {
  let notified: Send<Message> | undefined;
  const update = () => {
    const send = input();
    if (send === notified) return;
    notified = send;
    send({ type: 'Load' });
  };
  const focus = () => {
    if (document.visibilityState === 'visible') input()({ type: 'Load' });
  };
  update();
  window.addEventListener('focus', focus);
  return { update, dispose: () => window.removeEventListener('focus', focus) };
}
const sessionsMount = (send: Send<Message>) => domBinding(send, acquireSessions);
const sessionDate = (date: number) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date * 1000);
const SessionIcon = view<{ session: TelegramActiveSession }>((props) =>
  /android|ios|iphone|ipad/i.test(props.session.platform + ' ' + props.session.device) ? (
    <Smartphone size={28} />
  ) : /web|browser/i.test(props.session.appName + ' ' + props.session.device) ? (
    <Globe size={28} />
  ) : (
    <Monitor size={28} />
  ),
);
const ttlChoices = [
  { id: 7, label: '1 week' },
  { id: 30, label: '1 month' },
  { id: 90, label: '3 months' },
  { id: 180, label: '6 months' },
  { id: 365, label: '1 year' },
];
export const ActiveSessions = component<Props, State, Message>(
  {
    init: () => ({ page: undefined, busy: false, error: '', confirm: undefined }),
    update: (model, message) => {
      if (message.type === 'Loaded')
        return { model: { ...model, page: message.page, busy: false, error: '' } };
      if (message.type === 'Failed')
        return { model: { ...model, busy: false, error: message.error } };
      if (message.type === 'Confirm') return { model: { ...model, confirm: message.id } };
      if (model.busy || !model.props.online || (message.type === 'Load' && model.confirm))
        return { model };
      const api = model.props.api,
        page = model.page;
      let effect: Effect.Effect<TelegramActiveSessions, unknown>;
      if (message.type === 'Load') effect = Effect.suspend(api.getActiveSessions);
      else if (message.type === 'Ttl' && page)
        effect = Effect.suspend(() => api.setSessionTtl(message.days)).pipe(
          Effect.flatMap(() =>
            api
              .getActiveSessions()
              .pipe(Effect.catch(() => Effect.succeed({ ...page, ttlDays: message.days }))),
          ),
        );
      else if (message.type === 'Terminate' && page && model.confirm) {
        const hash = model.confirm === 'all' ? undefined : model.confirm;
        effect = Effect.suspend(() => api.terminateSession(hash)).pipe(
          Effect.flatMap(() =>
            api
              .getActiveSessions()
              .pipe(
                Effect.catch(() =>
                  Effect.succeed({
                    ...page,
                    sessions: page.sessions.filter(
                      (session) => session.current || (hash !== undefined && session.id !== hash),
                    ),
                  }),
                ),
              ),
          ),
        );
      } else return { model };
      return {
        model: { ...model, busy: true, error: '', confirm: undefined },
        commands: [
          {
            key: 'sessions',
            policy: 'drop',
            effect: effect.pipe(
              Effect.match({
                onSuccess: (page) => ({ type: 'Loaded', page }) as const,
                onFailure: (error) =>
                  ({
                    type: 'Failed',
                    error:
                      error instanceof Error
                        ? error.message
                        : 'Could not load devices. Check your connection.',
                  }) as const,
              }),
            ),
          },
        ],
      };
    },
  },
  view((model, send) => {
    const sessions = model.page?.sessions ?? [],
      current = sessions.filter((session) => session.current),
      others = sessions.filter((session) => !session.current);
    const target = sessions.find((session) => session.id === model.confirm);
    const row = (session: TelegramActiveSession) => (
      <button
        class="device-row"
        disabled={model.busy || !model.props.online}
        onClick={() => send({ type: 'Confirm', id: session.id })}
        title={session.current ? 'Current session' : `Manage ${session.device}`}
      >
        <span class="device-icon">
          <SessionIcon session={session} />
        </span>
        <span class="device-copy">
          <strong>{session.device || session.platform || session.appName}</strong>
          <span>
            {session.appName} {session.appVersion}
          </span>
          <small>
            {[session.country, session.region].filter(Boolean).join(', ')}
            {session.current ? ' · online' : ` · ${sessionDate(session.activeAt)}`}
          </small>
          {session.passwordPending ? (
            <small>Awaiting password</small>
          ) : session.unconfirmed ? (
            <small>New login</small>
          ) : null}
        </span>
      </button>
    );
    return (
      <div class="active-sessions" use={sessionsMount(send)} aria-busy={model.busy}>
        {!model.props.online ? (
          <p class="device-notice">Connect to the internet to manage devices.</p>
        ) : null}
        {model.busy && !model.page ? (
          <p class="device-notice" role="status">
            Loading devices…
          </p>
        ) : null}
        {model.error ? (
          <p class="device-notice" role="alert">
            {model.error}
          </p>
        ) : null}
        {current.length ? (
          <section>
            <h3>This device</h3>
            {list(idRows(current), row)}
          </section>
        ) : null}
        {others.length ? (
          <>
            <button
              class="terminate-all"
              disabled={model.busy || !model.props.online}
              onClick={() => send({ type: 'Confirm', id: 'all' })}
            >
              <LogOut size={20} />
              Terminate all other sessions
            </button>
            <p class="device-notice">Logs out all devices except this one.</p>
            <section>
              <h3>Active sessions</h3>
              {list(idRows(others), row)}
            </section>
          </>
        ) : model.page ? (
          <p class="device-notice">No other active sessions.</p>
        ) : null}
        {model.page ? (
          <section class="session-expiry">
            <h3>Automatically terminate old sessions</h3>
            <label>
              If inactive for
              <select
                aria-label="Session inactivity period"
                value={String(model.page.ttlDays)}
                disabled={model.busy || !model.props.online}
                onChange={(event) => send({ type: 'Ttl', days: Number(event.currentTarget.value) })}
              >
                {!ttlChoices.some((item) => item.id === model.page?.ttlDays) ? (
                  <option value={String(model.page.ttlDays)}>{model.page.ttlDays} days</option>
                ) : null}
                {list(idRows(ttlChoices), (item) => (
                  <option value={String(item.id)}>{item.label}</option>
                ))}
              </select>
            </label>
          </section>
        ) : null}
        {model.confirm ? (
          <Dialog
            title={model.confirm === 'all' ? 'Terminate other sessions' : 'Device details'}
            closeLabel="Cancel session termination"
            onClose={() => send({ type: 'Confirm', id: undefined })}
            class="session-confirm-dialog"
          >
            {target ? (
              <>
                <strong>{target.device}</strong>
                <p>
                  {target.appName} {target.appVersion}
                </p>
                <dl>
                  <dt>System</dt>
                  <dd>
                    {target.platform} {target.systemVersion}
                  </dd>
                  <dt>Location</dt>
                  <dd>{[target.country, target.region].filter(Boolean).join(', ') || 'Unknown'}</dd>
                  <dt>IP address</dt>
                  <dd>{target.ip}</dd>
                  <dt>Logged in</dt>
                  <dd>{sessionDate(target.createdAt)}</dd>
                  <dt>Last active</dt>
                  <dd>{sessionDate(target.activeAt)}</dd>
                </dl>
              </>
            ) : (
              <p>All other devices will be logged out. This device will stay connected.</p>
            )}
            <div class="session-confirm-actions">
              <button onClick={() => send({ type: 'Confirm', id: undefined })}>Cancel</button>
              {!target?.current ? (
                <button class="danger" onClick={() => send({ type: 'Terminate' })}>
                  {target ? 'Terminate session' : 'Terminate all'}
                </button>
              ) : null}
            </div>
          </Dialog>
        ) : null}
      </div>
    );
  }),
);
