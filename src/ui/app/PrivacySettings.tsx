import { component, domBinding, list, view, type Send } from 'effectweb';
import { Effect } from 'effect';
import ChevronRight from '@effectweb/lucide/icons/chevron-right';
import X from '@effectweb/lucide/icons/x';
import type {
  TelegramDialog,
  TelegramPeer,
  TelegramPeerSearchResult,
  TelegramPrivacyAudience,
  TelegramPrivacyChange,
  TelegramPrivacyKey,
  TelegramPrivacySetting,
} from '../../telegram/types';
import type { ChatSummary } from '../../domain/models';
import {
  changePrivacyRules,
  privacyAudience,
  privacyExceptions,
  privacyKeys,
} from '../../domain/privacy';
import { idRows } from '../collections';
import { Dialog } from '../shared/Dialog';
import { Avatar } from '../shared/Avatar';
import type { MediaAssets } from '../media/mediaAssets';
import { ForwardMessageDialog } from '../conversation/ForwardMessageDialog';

export interface PrivacyApi {
  getPrivacy: (key: TelegramPrivacyKey) => Effect.Effect<TelegramPrivacySetting, unknown>;
  setPrivacy: (
    key: TelegramPrivacyKey,
    change: TelegramPrivacyChange,
  ) => Effect.Effect<TelegramPrivacySetting, unknown>;
  getReadTimePrivacy: () => Effect.Effect<boolean, unknown>;
  setReadTimePrivacy: (hidden: boolean) => Effect.Effect<boolean, unknown>;
  searchPeers: (query: string) => Effect.Effect<TelegramPeerSearchResult[], unknown>;
}
interface Props {
  api: PrivacyApi;
  online: boolean;
  media: MediaAssets;
  dialogs: readonly TelegramDialog[];
  chats: ChatSummary[];
}
type Settings = Partial<Record<TelegramPrivacyKey, TelegramPrivacySetting>>;
interface State {
  requested: boolean;
  busy: boolean;
  settings: Settings;
  errors: Partial<Record<TelegramPrivacyKey, string>>;
  hidden: boolean | undefined;
  active: TelegramPrivacyKey | undefined;
  draft: TelegramPrivacySetting | undefined;
  audience: TelegramPrivacyAudience | undefined;
  edits: NonNullable<TelegramPrivacyChange['exceptions']>;
  picker: boolean | undefined;
  exceptionList: boolean | undefined;
  error: string;
}
type Message =
  | { type: 'Load' }
  | { type: 'Loaded'; settings: Settings; errors: State['errors']; hidden: boolean | undefined }
  | { type: 'Open'; key: TelegramPrivacyKey }
  | { type: 'Close' }
  | { type: 'Audience'; value: TelegramPrivacyAudience }
  | { type: 'ExceptionList'; allow: boolean | undefined }
  | { type: 'Picker'; allow: boolean | undefined }
  | {
      type: 'Exception';
      peer: TelegramPeer;
      allow: boolean;
      remove?: boolean;
      person?: TelegramPeerSearchResult;
    }
  | { type: 'Save' }
  | { type: 'Saved'; value: TelegramPrivacySetting }
  | { type: 'HideReadTime'; value: boolean }
  | { type: 'Hidden'; value: boolean }
  | { type: 'Failed'; error: string };
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Could not update privacy settings. Check your connection.';
function acquirePrivacy(_element: HTMLElement, input: () => Send<Message>) {
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
const privacyMount = (send: Send<Message>) => domBinding(send, acquirePrivacy);
const audienceLabels = {
  everyone: 'Everybody',
  contacts: 'My Contacts',
  nobody: 'Nobody',
  custom: 'Custom',
};
const audiences = [
  { id: 'everyone', label: 'Everybody' },
  { id: 'contacts', label: 'My Contacts' },
  { id: 'nobody', label: 'Nobody' },
] as const;
export const PrivacySettings = component<Props, State, Message>(
  {
    init: () => ({
      requested: false,
      busy: false,
      settings: {},
      errors: {},
      hidden: undefined,
      active: undefined,
      draft: undefined,
      audience: undefined,
      edits: [],
      picker: undefined,
      exceptionList: undefined,
      error: '',
    }),
    update: (model, message) => {
      if (message.type === 'Loaded')
        return {
          model: {
            ...model,
            busy: false,
            settings: message.settings,
            errors: message.errors,
            hidden: message.hidden,
          },
        };
      if (message.type === 'Failed')
        return { model: { ...model, busy: false, error: message.error } };
      if (message.type === 'Hidden')
        return { model: { ...model, busy: false, hidden: message.value } };
      if (message.type === 'Saved')
        return {
          model: {
            ...model,
            busy: false,
            settings: { ...model.settings, [message.value.key]: message.value },
            active: undefined,
            exceptionList: undefined,
            draft: undefined,
            edits: [],
            audience: undefined,
            error: '',
          },
        };
      if (message.type === 'Close')
        return model.busy
          ? { model }
          : {
              model: {
                ...model,
                active: undefined,
                draft: undefined,
                picker: undefined,
                exceptionList: undefined,
                error: '',
              },
            };
      if (message.type === 'ExceptionList' && message.allow === undefined)
        return { model: { ...model, exceptionList: undefined } };
      if (message.type === 'Picker' && message.allow === undefined)
        return { model: { ...model, picker: undefined } };
      if (model.busy || !model.props.online) return { model };
      if (message.type === 'Open') {
        const draft = model.settings[message.key];
        return draft
          ? {
              model: {
                ...model,
                active: message.key,
                draft,
                audience: undefined,
                edits: [],
                error: '',
              },
            }
          : { model };
      }
      if (message.type === 'Audience')
        return { model: { ...model, audience: message.value, error: '' } };
      if (message.type === 'ExceptionList')
        return { model: { ...model, exceptionList: message.allow } };
      if (message.type === 'Picker') return { model: { ...model, picker: message.allow } };
      if (message.type === 'Exception' && model.draft) {
        const edit = {
          peer: message.peer,
          allow: message.allow,
          ...(message.remove ? { remove: true } : {}),
        };
        return {
          model: {
            ...model,
            picker: undefined,
            edits: [...model.edits, edit],
            draft: {
              ...model.draft,
              rules: changePrivacyRules(model.draft.rules, { exceptions: [edit] }),
              peers: message.person
                ? [
                    ...model.draft.peers.filter((person) => person.peer.id !== message.peer.id),
                    message.person,
                  ]
                : model.draft.peers,
            },
          },
        };
      }
      let effect: Effect.Effect<Message, never>;
      if (message.type === 'Load') {
        if (model.active) return { model };
        effect = Effect.gen(function* () {
          const entries = yield* Effect.forEach(
            privacyKeys,
            (item) =>
              Effect.suspend(() => model.props.api.getPrivacy(item.id)).pipe(
                Effect.result,
                Effect.map((result) => ({ key: item.id, result })),
              ),
            { concurrency: 3 },
          );
          const hidden = yield* Effect.suspend(model.props.api.getReadTimePrivacy).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          const settings: Settings = {},
            errors: State['errors'] = {};
          for (const entry of entries) {
            if (entry.result._tag === 'Success') settings[entry.key] = entry.result.success;
            else errors[entry.key] = errorText(entry.result.failure);
          }
          return { type: 'Loaded', settings, errors, hidden } as const;
        });
      } else if (message.type === 'Save' && model.active) {
        const key = model.active;
        effect = Effect.suspend(() =>
          model.props.api.setPrivacy(key, {
            ...(model.audience ? { audience: model.audience } : {}),
            exceptions: model.edits,
          }),
        ).pipe(
          Effect.match({
            onSuccess: (value) => ({ type: 'Saved', value }) as const,
            onFailure: (error) => ({ type: 'Failed', error: errorText(error) }) as const,
          }),
        );
      } else if (message.type === 'HideReadTime')
        effect = Effect.suspend(() => model.props.api.setReadTimePrivacy(message.value)).pipe(
          Effect.match({
            onSuccess: (value) => ({ type: 'Hidden', value }) as const,
            onFailure: (error) => ({ type: 'Failed', error: errorText(error) }) as const,
          }),
        );
      else return { model };
      return {
        model: { ...model, requested: true, busy: true, error: '' },
        commands: [{ key: 'privacy', policy: 'drop', effect }],
      };
    },
  },
  view((model, send) => {
    const active = privacyKeys.find((item) => item.id === model.active),
      draft = model.draft;
    const editable = Boolean(draft && !draft.rules.some((rule) => rule.kind === 'unsupported'));
    const selected = model.audience ?? (draft ? privacyAudience(draft.rules) : 'custom');
    const exceptions = draft ? privacyExceptions(draft) : [];
    return (
      <div class="privacy-settings" use={privacyMount(send)} aria-busy={model.busy}>
        {!model.props.online ? (
          <p class="device-notice">Connect to the internet to change privacy settings.</p>
        ) : null}
        {model.busy && !Object.keys(model.settings).length ? (
          <p class="device-notice" role="status">
            Loading privacy settings…
          </p>
        ) : null}
        {model.error && !model.active ? (
          <p class="device-notice" role="alert">
            {model.error}
          </p>
        ) : null}
        {list(idRows(privacyKeys), (item) => {
          const setting = model.settings[item.id],
            count = setting ? privacyExceptions(setting).length : 0;
          return (
            <button
              class="privacy-setting-row"
              disabled={!setting || model.busy || !model.props.online}
              title={model.errors[item.id] ?? item.question}
              onClick={() => send({ type: 'Open', key: item.id })}
            >
              <span>{item.label}</span>
              <small>
                {setting
                  ? `${audienceLabels[privacyAudience(setting.rules)]}${count ? ` (+${count})` : ''}`
                  : model.errors[item.id]
                    ? 'Unavailable'
                    : '…'}
              </small>
              <ChevronRight size={16} />
            </button>
          );
        })}
        <label class="privacy-read-time">
          <span>Hide read time</span>
          <input
            type="checkbox"
            checked={Boolean(model.hidden)}
            disabled={model.hidden === undefined || model.busy || !model.props.online}
            onChange={(event) => send({ type: 'HideReadTime', value: event.currentTarget.checked })}
          />
        </label>
        {active && draft ? (
          <Dialog
            title={active.label}
            closeLabel="Cancel privacy changes"
            onClose={() => send({ type: 'Close' })}
            class="privacy-editor"
          >
            <h3>{active.question}</h3>
            <fieldset disabled={!editable || model.busy || !model.props.online}>
              {list(
                idRows(
                  audiences.filter(
                    (item) => active.id !== 'added-by-phone' || item.id !== 'nobody',
                  ),
                ),
                (item) => (
                  <label class="privacy-radio">
                    <input
                      type="radio"
                      name="privacy-audience"
                      value={item.id}
                      checked={selected === item.id}
                      onChange={() => send({ type: 'Audience', value: item.id })}
                    />
                    {item.label}
                  </label>
                ),
              )}
            </fieldset>
            {selected === 'custom' ? (
              <p class="device-notice">Custom privacy rules are active.</p>
            ) : null}
            {draft.rules.some((rule) => rule.kind === 'allow-premium') ? (
              <p class="device-notice">Premium users are always allowed.</p>
            ) : null}
            {draft.rules.some((rule) => rule.kind === 'allow-bots' || rule.kind === 'deny-bots') ? (
              <p class="device-notice">
                Bots:{' '}
                {draft.rules.some((rule) => rule.kind === 'deny-bots')
                  ? 'Never allow'
                  : 'Always allow'}
              </p>
            ) : null}
            {active.id !== 'added-by-phone' ? (
              <div class="privacy-exceptions">
                <h3>Exceptions</h3>
                {list([true, false], (allow) => (
                  <section>
                    <button
                      class="privacy-exception-heading"
                      disabled={!editable || model.busy}
                      onClick={() => send({ type: 'ExceptionList', allow })}
                    >
                      <span>{allow ? 'Always allow' : 'Never allow'}</span>
                      <span>
                        {exceptions.filter((item) => item.allow === allow).length || 'Add users'}
                      </span>
                    </button>
                  </section>
                ))}
              </div>
            ) : null}
            {model.error ? (
              <p class="device-notice" role="alert">
                {model.error}
              </p>
            ) : null}
            <div class="privacy-editor-actions">
              <button disabled={model.busy} onClick={() => send({ type: 'Close' })}>
                Cancel
              </button>
              <button
                disabled={!editable || model.busy || (!model.audience && !model.edits.length)}
                onClick={() => send({ type: 'Save' })}
              >
                {model.busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </Dialog>
        ) : null}
        {model.exceptionList !== undefined && draft ? (
          <Dialog
            title={model.exceptionList ? 'Always allow' : 'Never allow'}
            label="Privacy exceptions"
            closeLabel="Close exceptions"
            class="privacy-editor privacy-exception-list"
            onClose={() => send({ type: 'ExceptionList', allow: undefined })}
          >
            <button
              class="privacy-exception-heading"
              onClick={() => send({ type: 'Picker', allow: model.exceptionList })}
            >
              <span>Add users or groups</span>
              <ChevronRight size={18} />
            </button>
            <div class="privacy-exception-scroll">
              {list(
                idRows(exceptions.filter((item) => item.allow === model.exceptionList)),
                (item) => {
                  const person = draft.peers.find((person) => person.peer.id === item.peer.id),
                    chat = model.props.dialogs.find((chat) => chat.peer.id === item.peer.id);
                  const title =
                    person?.title ?? chat?.title ?? (item.peer.kind === 'user' ? 'User' : 'Group');
                  return (
                    <div class="privacy-exception-person">
                      <Avatar
                        identity={item.peer.id}
                        initials={person?.initials ?? chat?.initials ?? '?'}
                        color={person?.color ?? chat?.color ?? '#408acf'}
                        size="sm"
                        loadCached={() =>
                          model.props.media.loadPeerAvatar(
                            item.peer,
                            person?.hasAvatar ?? chat?.hasAvatar ?? false,
                            person?.avatarId ?? chat?.avatarId,
                            true,
                          )
                        }
                        load={
                          model.props.online
                            ? () =>
                                model.props.media.loadPeerAvatar(
                                  item.peer,
                                  person?.hasAvatar ?? chat?.hasAvatar ?? false,
                                  person?.avatarId ?? chat?.avatarId,
                                )
                            : undefined
                        }
                      />
                      <span>{title}</span>
                      <button
                        disabled={!editable || model.busy}
                        aria-label={`Remove ${title} exception`}
                        title="Remove exception"
                        onClick={() =>
                          send({
                            type: 'Exception',
                            peer: item.peer,
                            allow: Boolean(model.exceptionList),
                            remove: true,
                          })
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  );
                },
              )}

              {!exceptions.some((item) => item.allow === model.exceptionList) ? (
                <p class="device-notice">No exceptions added.</p>
              ) : null}
            </div>
            <p class="device-notice">
              These exceptions override the setting above. Changes apply when you save the privacy
              setting.
            </p>
            <div class="privacy-editor-actions">
              <button onClick={() => send({ type: 'ExceptionList', allow: undefined })}>
                Done
              </button>
            </div>
          </Dialog>
        ) : null}
        {model.picker !== undefined ? (
          <ForwardMessageDialog
            overlayLayer={100}
            title={model.picker ? 'Always allow' : 'Never allow'}
            label="Choose privacy exception"
            cancelLabel="Cancel choosing exception"
            media={model.props.media}
            online={model.props.online}
            chats={model.props.chats.filter((chat) => {
              const dialog = model.props.dialogs.find((dialog) => dialog.peer.id === chat.id);
              return (
                dialog && (dialog.peer.kind !== 'channel' || dialog.permissions?.canViewMembers)
              );
            })}
            search={(query) =>
              model.props.api
                .searchPeers(query)
                .pipe(
                  Effect.map((people) => people.filter((person) => person.category !== 'channel')),
                )
            }
            close={() => send({ type: 'Picker', allow: undefined })}
            forward={(id, person) => {
              const peer =
                person?.peer ?? model.props.dialogs.find((dialog) => dialog.peer.id === id)?.peer;
              if (peer)
                send({
                  type: 'Exception',
                  peer,
                  allow: Boolean(model.picker),
                  ...(person ? { person } : {}),
                });
            }}
          />
        ) : null}
      </div>
    );
  }),
);
