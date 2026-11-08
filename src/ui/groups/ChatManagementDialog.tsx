import { AdminLogDialog } from './AdminLogDialog';
import History from '@effectweb/lucide/icons/history';
import { expandedRestrictions, permissionKeys, permissionLabels } from './participantEditor';
import type { ChatRestrictions } from '../../telegram/chatManagement';
import { ParticipantsDialog } from './ParticipantsDialog';
import type { ChatParticipantFilter } from '../../telegram/chatManagement';
import type { MediaAssets } from '../media/mediaAssets';
import Users from '@effectweb/lucide/icons/users';
import Shield from '@effectweb/lucide/icons/shield';
import { Effect } from 'effect';
import { collection, component, list, sequence, view } from 'effectweb';
import ArrowLeft from '@effectweb/lucide/icons/arrow-left';
import ChevronRight from '@effectweb/lucide/icons/chevron-right';
import Link from '@effectweb/lucide/icons/link';
import UserPlus from '@effectweb/lucide/icons/user-plus';
import type { EffectMessagingClient } from '../../telegram/core/client';
import type { ChatManagementSettings, ChatSettingChange } from '../../telegram/chatManagement';
import type { TelegramPeer, TelegramDialog } from '../../telegram/types';
import { idRows } from '../collections';
import { Dialog } from '../shared/Dialog';
import { panelClass } from '../shared/panelStyles';
import { groupResourceSubscription } from './groupResourceSubscription';
const permissionRows = collection<keyof typeof permissionLabels>((key) => key).from;
type Setting = ChatSettingChange['kind'];
interface Props {
  api: EffectMessagingClient;
  dialog: TelegramDialog;
  online: boolean;
  media: MediaAssets;
  dialogs: TelegramDialog[];
  close: () => void;
  links: () => void;
  requests: () => void;
  changed: (change: ChatSettingChange) => void;
  initialSetting?: Setting | undefined;
  upgraded: (peer: TelegramPeer, setting: Setting) => void;
}
interface State {
  participants: ChatParticipantFilter | undefined;
  log: boolean;
  upgradeFor: Setting | undefined;
  settings: ChatManagementSettings | undefined;
  editing: Setting | undefined;
  value: string;
  publicChat: boolean;
  restrictions: ChatRestrictions;
  loading: boolean;
  busy: boolean;
  error: string;
}
type Message =
  | { type: 'Log'; open: boolean }
  | { type: 'Upgrade' }
  | { type: 'Upgraded'; peer: TelegramPeer; setting: Setting }
  | { type: 'Participants'; filter: ChatParticipantFilter | undefined }
  | { type: 'Permission'; key: keyof ChatRestrictions; allowed: boolean }
  | { type: 'Load' }
  | { type: 'Loaded'; settings: ChatManagementSettings }
  | { type: 'Edit'; kind: Setting }
  | { type: 'Back' }
  | { type: 'Value'; value: string }
  | { type: 'Public'; value: boolean }
  | { type: 'Save' }
  | { type: 'Saved'; change: ChatSettingChange }
  | { type: 'Failed'; error: string };
const names: Record<Setting, string> = {
  defaultRestrictions: 'Permissions',
  title: 'Name',
  about: 'Description',
  username: 'Chat type',
  forum: 'Topics',
  slowModeSeconds: 'Slow mode',
  hiddenHistory: 'History for new members',
  protectedContent: 'Content protection',
};
const durations: Record<string, string> = {
  0: 'Off',
  10: '10 seconds',
  30: '30 seconds',
  60: '1 minute',
  300: '5 minutes',
  900: '15 minutes',
  3600: '1 hour',
};
function changeFor(
  kind: Setting,
  value: string,
  publicChat: boolean,
  restrictions: ChatRestrictions,
): ChatSettingChange {
  if (kind === 'defaultRestrictions') return { kind, value: restrictions };
  if (kind === 'title' || kind === 'about' || kind === 'username')
    return { kind, value: kind === 'username' && !publicChat ? '' : value.trim() };
  if (kind === 'slowModeSeconds') return { kind, value: Number(value) };
  return { kind, value: value === 'true' };
}
export const ChatManagementDialog = component<Props, State, Message>(
  {
    identity: (props) => props.dialog.peer.id,
    init: () => ({
      settings: undefined,
      log: false,
      upgradeFor: undefined,
      participants: undefined,
      editing: undefined,
      value: '',
      publicChat: false,
      restrictions: {},
      loading: false,
      busy: false,
      error: '',
    }),
    update: (model, message) => {
      const peer = model.props.dialog.peer;
      switch (message.type) {
        case 'Permission':
          return {
            model: {
              ...model,
              restrictions: { ...model.restrictions, [message.key]: !message.allowed },
            },
          };
        case 'Log':
          return { model: { ...model, log: message.open } };
        case 'Participants':
          return { model: { ...model, participants: message.filter } };
        case 'Load':
          return !model.props.online
            ? { model }
            : {
                model: { ...model, loading: true, error: '' },
                commands: [
                  {
                    key: ['management', peer.id],
                    policy: 'replace',
                    effect: model.props.api
                      .getChatManagement(peer)
                      .pipe(
                        Effect.match({
                          onSuccess: (settings): Message => ({ type: 'Loaded', settings }),
                          onFailure: (error): Message => ({ type: 'Failed', error: error.message }),
                        }),
                      ),
                  },
                ],
              };
        case 'Loaded': {
          const editing = !model.settings ? model.props.initialSetting : model.editing;
          return {
            model: {
              ...model,
              loading: false,
              settings: message.settings,
              editing,
              ...(!model.settings && editing
                ? {
                    value:
                      editing === 'defaultRestrictions' ? '' : String(message.settings[editing]),
                    publicChat: Boolean(message.settings.username),
                    restrictions: expandedRestrictions(message.settings.defaultRestrictions ?? {}),
                  }
                : {}),
            },
          };
        }
        case 'Upgrade': {
          if (!model.upgradeFor || model.busy || !model.props.online) return { model };
          const setting = model.upgradeFor;
          return {
            model: { ...model, busy: true, error: '' },
            commands: [
              {
                key: ['upgrade', peer.id],
                policy: 'drop',
                effect: model.props.api
                  .upgradeChat(peer)
                  .pipe(
                    Effect.match({
                      onSuccess: (peer): Message => ({ type: 'Upgraded', peer, setting }),
                      onFailure: (error): Message => ({ type: 'Failed', error: error.message }),
                    }),
                  ),
              },
            ],
          };
        }
        case 'Upgraded':
          return {
            model: { ...model, busy: false },
            commands: [
              {
                key: ['upgraded', peer.id],
                policy: 'drop',
                effect: Effect.sync(() => model.props.upgraded(message.peer, message.setting)).pipe(
                  Effect.as({ type: 'Back' } as Message),
                ),
              },
            ],
          };

        case 'Edit':
          if (
            peer.kind === 'group' &&
            ['username', 'forum', 'slowModeSeconds', 'hiddenHistory'].includes(message.kind)
          )
            return { model: { ...model, upgradeFor: message.kind, error: '' } };
          return !model.settings
            ? { model }
            : {
                model: {
                  ...model,
                  editing: message.kind,
                  restrictions: expandedRestrictions(model.settings.defaultRestrictions ?? {}),
                  value:
                    message.kind === 'defaultRestrictions'
                      ? ''
                      : String(model.settings[message.kind]),
                  publicChat: Boolean(model.settings.username),
                  error: '',
                },
              };
        case 'Back':
          return model.busy
            ? { model }
            : { model: { ...model, editing: undefined, upgradeFor: undefined, error: '' } };
        case 'Value':
          return { model: { ...model, value: message.value } };
        case 'Public':
          return { model: { ...model, publicChat: message.value } };
        case 'Failed':
          return { model: { ...model, loading: false, busy: false, error: message.error } };
        case 'Save': {
          if (!model.editing || model.busy || !model.props.online) return { model };
          const change = changeFor(
            model.editing,
            model.value,
            model.publicChat,
            model.restrictions,
          );
          return {
            model: { ...model, busy: true, error: '' },
            commands: [
              {
                key: ['setting', peer.id],
                policy: 'drop',
                effect: model.props.api
                  .setChatSetting(peer, change)
                  .pipe(
                    Effect.match({
                      onSuccess: (): Message => ({ type: 'Saved', change }),
                      onFailure: (error): Message => ({ type: 'Failed', error: error.message }),
                    }),
                  ),
              },
            ],
          };
        }
        case 'Saved':
          return {
            model: { ...model, editing: undefined, busy: false },
            commands: [
              {
                key: ['setting-saved', peer.id],
                policy: 'replace',
                effect: Effect.sync(() => model.props.changed(message.change)).pipe(
                  Effect.as({ type: 'Load' } as Message),
                ),
              },
            ],
          };
      }
    },
  },
  view((model, send) => {
    const props = model.props;
    const settings = model.settings;
    const editing = model.editing;
    if (model.upgradeFor)
      return (
        <Dialog
          title="Enable advanced group settings?"
          class={`${panelClass} !max-w-[460px]`}
          onClose={() => {
            if (!model.busy) send({ type: 'Back' });
          }}
        >
          <div class="chat-management-body">
            <p class="management-help">
              To change {names[model.upgradeFor].toLowerCase()}, Telegram needs to upgrade this
              group to a supergroup. Members and messages are kept. This upgrade cannot be undone.
            </p>
            {model.error ? (
              <p role="alert" class="text-sm text-red-400">
                {model.error}
              </p>
            ) : null}
            <div class="folder-footer">
              <button
                class="secondary-button"
                disabled={model.busy}
                onClick={() => send({ type: 'Back' })}
              >
                Cancel
              </button>
              <button
                class="primary-button"
                disabled={model.busy || !props.online}
                onClick={() => send({ type: 'Upgrade' })}
              >
                {model.busy ? 'Upgrading…' : 'Continue'}
              </button>
            </div>
          </div>
        </Dialog>
      );
    if (model.log)
      return (
        <AdminLogDialog
          api={props.api}
          dialog={props.dialog}
          online={props.online}
          media={props.media}
          close={() => send({ type: 'Log', open: false })}
        />
      );
    if (model.participants && settings)
      return (
        <ParticipantsDialog
          api={props.api}
          dialog={props.dialog}
          settings={settings}
          initialFilter={model.participants}
          dialogs={props.dialogs}
          online={props.online}
          media={props.media}
          close={() => send({ type: 'Participants', filter: undefined })}
        />
      );
    const rows = settings
      ? [
          ...(!settings.broadcast && settings.rights.restrictMembers
            ? [{ id: 'defaultRestrictions' as const, value: 'What members can do' }]
            : []),
          ...(settings.rights.changeInfo
            ? [
                { id: 'title' as const, value: settings.title },
                { id: 'about' as const, value: settings.about || 'Add a description' },
              ]
            : []),
          ...(settings.rights.changeType
            ? [
                {
                  id: 'username' as const,
                  value: settings.username ? `Public · t.me/${settings.username}` : 'Private',
                },
              ]
            : []),
          ...(!settings.broadcast &&
          (props.dialog.peer.kind === 'channel' || settings.rights.changeType) &&
          settings.rights.manageTopics
            ? [{ id: 'forum' as const, value: settings.forum ? 'Enabled' : 'Disabled' }]
            : []),
          ...(!settings.broadcast &&
          (props.dialog.peer.kind === 'channel' || settings.rights.changeType) &&
          settings.rights.restrictMembers
            ? [
                {
                  id: 'slowModeSeconds' as const,
                  value:
                    durations[String(settings.slowModeSeconds)] ??
                    `${settings.slowModeSeconds} seconds`,
                },
              ]
            : []),
          ...(!settings.broadcast &&
          !settings.forum &&
          !settings.username &&
          settings.rights.changeType
            ? [
                {
                  id: 'hiddenHistory' as const,
                  value: settings.hiddenHistory ? 'Hidden' : 'Visible',
                },
              ]
            : []),
          ...(settings.rights.changeType
            ? [
                {
                  id: 'protectedContent' as const,
                  value: settings.protectedContent ? 'Enabled' : 'Disabled',
                },
              ]
            : []),
        ]
      : [];
    return (
      <Dialog
        title={editing ? names[editing] : settings?.broadcast ? 'Manage channel' : 'Manage group'}
        class={`${panelClass} !max-w-[460px]`}
        onClose={() => {
          if (!model.busy) props.close();
        }}
        headerLeading={
          editing ? (
            <button
              class="icon-button"
              aria-label="Back"
              disabled={model.busy}
              onClick={() => send({ type: 'Back' })}
            >
              <ArrowLeft size={20} />
            </button>
          ) : undefined
        }
      >
        <span
          hidden
          use={groupResourceSubscription({
            api: props.api,
            peerId: props.dialog.peer.id,
            kind: 'chat-management',
            online: props.online,
            reload: () => send({ type: 'Load' }),
          })}
        />
        <div class="chat-management-body scroll-area">
          {!editing ? (
            <>
              {list(idRows(rows), (row) => (
                <button
                  class="chat-management-row"
                  onClick={() => send({ type: 'Edit', kind: row.id })}
                >
                  <span>
                    <strong>{names[row.id]}</strong>
                    <small>{row.value}</small>
                  </span>
                  <ChevronRight size={18} />
                </button>
              ))}
              {settings ? (
                <div class="chat-management-section">
                  <button
                    class="folder-main"
                    onClick={() => send({ type: 'Participants', filter: 'members' })}
                  >
                    <Users size={20} />
                    <span>Members</span>
                    <ChevronRight size={18} />
                  </button>
                  <button
                    class="folder-main"
                    onClick={() => send({ type: 'Participants', filter: 'admins' })}
                  >
                    <Shield size={20} />
                    <span>Administrators</span>
                    <ChevronRight size={18} />
                  </button>
                  {settings.rights.restrictMembers && props.dialog.peer.kind === 'channel' ? (
                    <button
                      class="folder-main"
                      onClick={() => send({ type: 'Participants', filter: 'restricted' })}
                    >
                      <Shield size={20} />
                      <span>Restricted users</span>
                      <ChevronRight size={18} />
                    </button>
                  ) : null}
                </div>
              ) : null}
              {settings?.rights.viewLog ? (
                <button class="folder-main" onClick={() => send({ type: 'Log', open: true })}>
                  <History size={20} />
                  <span>Recent actions</span>
                  <ChevronRight size={18} />
                </button>
              ) : null}
              {settings?.rights.manageInvites ? (
                <div class="chat-management-section">
                  <button class="folder-main" onClick={props.links}>
                    <Link size={20} />
                    <span>Invitation links</span>
                    <ChevronRight size={18} />
                  </button>
                  <button class="folder-main" onClick={props.requests}>
                    <UserPlus size={20} />
                    <span>Join requests</span>
                    <ChevronRight size={18} />
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                send({ type: 'Save' });
              }}
            >
              {editing === 'defaultRestrictions' ? (
                <>
                  <p class="management-help">
                    Choose what all members can do. Individual restrictions can limit these
                    permissions further.
                  </p>
                  {list(
                    permissionRows(
                      permissionKeys.filter((key) => settings?.forum || key !== 'manageTopics'),
                    ),
                    (key) => (
                      <label class="participant-permission">
                        <span>{permissionLabels[key]}</span>
                        <input
                          type="checkbox"
                          checked={!model.restrictions[key]}
                          disabled={model.busy}
                          onChange={(event) =>
                            send({ type: 'Permission', key, allowed: event.currentTarget.checked })
                          }
                        />
                      </label>
                    ),
                  )}
                </>
              ) : editing === 'title' || editing === 'about' ? (
                <label class="create-chat-field">
                  <span>{names[editing]}</span>
                  {editing === 'title' ? (
                    <input
                      value={model.value}
                      required
                      maxLength={128}
                      disabled={model.busy}
                      onInput={(event) => send({ type: 'Value', value: event.currentTarget.value })}
                    />
                  ) : (
                    <textarea
                      rows={4}
                      maxLength={255}
                      value={model.value}
                      disabled={model.busy}
                      onInput={(event) => send({ type: 'Value', value: event.currentTarget.value })}
                    />
                  )}
                </label>
              ) : editing === 'username' ? (
                <>
                  <label class="management-choice">
                    <input
                      type="radio"
                      name="chat-type"
                      checked={!model.publicChat}
                      disabled={model.busy}
                      onChange={() => send({ type: 'Public', value: false })}
                    />
                    <span>
                      Private<small>People can join using an invitation link.</small>
                    </span>
                  </label>
                  <label class="management-choice">
                    <input
                      type="radio"
                      name="chat-type"
                      checked={model.publicChat}
                      disabled={model.busy}
                      onChange={() => send({ type: 'Public', value: true })}
                    />
                    <span>
                      Public<small>Anyone can find the chat and open its public link.</small>
                    </span>
                  </label>
                  {model.publicChat ? (
                    <label class="create-chat-field">
                      <span>Public username</span>
                      <input
                        value={model.value}
                        placeholder="username"
                        required
                        minLength={5}
                        maxLength={32}
                        disabled={model.busy}
                        onInput={(event) =>
                          send({
                            type: 'Value',
                            value: event.currentTarget.value.replace(/^@/, ''),
                          })
                        }
                      />
                      <small>t.me/{model.value || 'username'}</small>
                    </label>
                  ) : null}
                </>
              ) : editing === 'slowModeSeconds' ? (
                <>
                  <p class="text-sm text-muted">
                    Choose how long members must wait between messages.
                  </p>
                  <label class="create-chat-field">
                    <span>Message interval</span>
                    <select
                      value={model.value}
                      disabled={model.busy}
                      onChange={(event) =>
                        send({ type: 'Value', value: event.currentTarget.value })
                      }
                    >
                      {list(sequence(['0', '10', '30', '60', '300', '900', '3600']), (value) => (
                        <option value={value}>{durations[value]}</option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <>
                  <p class="management-help">
                    {editing === 'forum'
                      ? 'Organize conversations into separate topics. Existing messages remain in General.'
                      : editing === 'hiddenHistory'
                        ? 'Choose whether new members can see messages sent before they joined.'
                        : 'Restrict forwarding and saving content from this chat.'}
                  </p>
                  {list(sequence(['false', 'true']), (value) => (
                    <label class="management-choice">
                      <input
                        type="radio"
                        name="setting-value"
                        value={value}
                        checked={model.value === value}
                        disabled={model.busy}
                        onChange={() => send({ type: 'Value', value })}
                      />
                      <span>
                        {editing === 'hiddenHistory'
                          ? value === 'true'
                            ? 'Hidden'
                            : 'Visible'
                          : value === 'true'
                            ? 'Enabled'
                            : 'Disabled'}
                      </span>
                    </label>
                  ))}
                </>
              )}
              <div class="folder-footer">
                <button
                  class="secondary-button"
                  type="button"
                  disabled={model.busy}
                  onClick={() => send({ type: 'Back' })}
                >
                  Cancel
                </button>
                <button class="primary-button" type="submit" disabled={model.busy || !props.online}>
                  {model.busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          )}
          {model.loading && !settings ? <p role="status">Loading settings…</p> : null}
          {model.error ? (
            <p role="alert" class="text-sm text-red-400">
              {model.error}
            </p>
          ) : null}
          {!props.online ? (
            <p role="status" class="text-sm text-muted">
              Connect to Telegram to manage this chat.
            </p>
          ) : null}
        </div>
      </Dialog>
    );
  }),
);
