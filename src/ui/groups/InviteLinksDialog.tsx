import { Effect } from 'effect';
import { collection, component, list, sequence, view } from 'effectweb';
import ArrowLeft from '@effectweb/lucide/icons/arrow-left';
import ChevronRight from '@effectweb/lucide/icons/chevron-right';
import Plus from '@effectweb/lucide/icons/plus';
import Link from '@effectweb/lucide/icons/link';
import type { EffectMessagingClient } from '../../telegram/core/client';
import type {
  ChatInviteLink,
  ChatInviteLinkDraft,
  ChatInviteLinksPage,
} from '../../telegram/chatManagement';
import type { TelegramDialog } from '../../telegram/types';
import { Dialog } from '../shared/Dialog';
import { panelClass } from '../shared/panelStyles';
import { groupResourceSubscription } from './groupResourceSubscription';
interface Props {
  api: EffectMessagingClient;
  dialog: TelegramDialog;
  online: boolean;
  close: () => void;
}
interface State {
  now: number;
  page: 'list' | 'detail' | 'edit' | 'confirm';
  links: ChatInviteLinksPage | undefined;
  revoked: boolean;
  selected: ChatInviteLink | undefined;
  title: string;
  requestNeeded: boolean;
  expire: string;
  expirePreset: string;
  limitPreset: string;
  limit: string;
  loading: boolean;
  busy: boolean;
  error: string;
  notice: string;
}
type Message =
  | { type: 'Load'; more?: boolean }
  | { type: 'Loaded'; links: ChatInviteLinksPage; more: boolean; now: number }
  | { type: 'Tab'; revoked: boolean }
  | { type: 'Open'; link: ChatInviteLink }
  | { type: 'Edit'; link?: ChatInviteLink }
  | { type: 'Back' }
  | { type: 'Title' | 'Expire' | 'Limit'; value: string }
  | { type: 'ExpirePreset' | 'LimitPreset'; value: string }
  | { type: 'Approval'; value: boolean }
  | { type: 'Save' }
  | { type: 'Confirm' }
  | { type: 'Remove' }
  | { type: 'Done'; link?: ChatInviteLink }
  | { type: 'Error'; error: string }
  | { type: 'Copy'; url: string }
  | { type: 'Copied' };
const linkRows = collection<ChatInviteLink>((link) => link.url).from;
function localDate(seconds: number) {
  const date = new Date(seconds * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const linkState = (link: ChatInviteLink, now: number) =>
  link.revoked
    ? 'Revoked'
    : (link.expireDate && link.expireDate <= now) ||
        (link.usageLimit && link.usage >= link.usageLimit)
      ? 'Expired'
      : link.permanent
        ? 'Primary link'
        : link.requestNeeded
          ? 'Approval required'
          : 'Active';
export const InviteLinksDialog = component<Props, State, Message>(
  {
    identity: (props) => props.dialog.peer.id,
    init: () => ({
      now: 0,
      page: 'list',
      links: undefined,
      revoked: false,
      selected: undefined,
      title: '',
      requestNeeded: false,
      expire: '',
      expirePreset: 'never',
      limitPreset: 'unlimited',
      limit: '',
      loading: false,
      busy: false,
      error: '',
      notice: '',
    }),
    update: (model, message) => {
      const peer = model.props.dialog.peer;
      const run = (effect: Effect.Effect<Message, unknown>) => ({
        model: { ...model, busy: true, error: '', notice: '' },
        commands: [
          {
            key: ['invite-link-write', peer.id],
            policy: 'drop' as const,
            effect: effect.pipe(
              Effect.catch((error) =>
                Effect.succeed({
                  type: 'Error',
                  error: error instanceof Error ? error.message : 'Could not update the link.',
                } as Message),
              ),
            ),
          },
        ],
      });
      switch (message.type) {
        case 'Load':
        case 'Tab': {
          const revoked = message.type === 'Tab' ? message.revoked : model.revoked;
          const more = message.type === 'Load' && Boolean(message.more);
          if (!model.props.online || (more && !model.links?.nextOffset)) return { model };
          return {
            model: {
              ...model,
              revoked,
              loading: true,
              error: '',
              links: message.type === 'Tab' ? undefined : model.links,
            },
            commands: [
              {
                key: ['invite-links', peer.id],
                policy: 'replace',
                effect: model.props.api
                  .getChatInviteLinks(peer, revoked, more ? model.links?.nextOffset : undefined)
                  .pipe(
                    Effect.match({
                      onSuccess: (links): Message => ({
                        type: 'Loaded',
                        links,
                        more,
                        now: Math.floor(Date.now() / 1000),
                      }),
                      onFailure: (error): Message => ({ type: 'Error', error: error.message }),
                    }),
                  ),
              },
            ],
          };
        }
        case 'Loaded':
          return {
            model: {
              ...model,
              loading: false,
              now: message.now,
              links: {
                ...message.links,
                links: message.more
                  ? [
                      ...new Map(
                        [...(model.links?.links ?? []), ...message.links.links].map((link) => [
                          link.url,
                          link,
                        ]),
                      ).values(),
                    ]
                  : message.links.links,
              },
            },
          };
        case 'Open':
          return {
            model: { ...model, selected: message.link, page: 'detail', error: '', notice: '' },
          };
        case 'Edit':
          return {
            model: {
              ...model,
              selected: message.link,
              page: 'edit',
              title: message.link?.title ?? '',
              requestNeeded: message.link?.requestNeeded ?? false,
              expire: message.link?.expireDate ? localDate(message.link.expireDate) : '',
              expirePreset: message.link?.expireDate ? 'custom' : 'never',
              limitPreset: message.link?.usageLimit
                ? [1, 10, 100].includes(message.link.usageLimit)
                  ? String(message.link.usageLimit)
                  : 'custom'
                : 'unlimited',
              limit: message.link?.usageLimit ? String(message.link.usageLimit) : '',
              error: '',
              notice: '',
            },
          };
        case 'Back':
          return {
            model: {
              ...model,
              page: model.page === 'confirm' ? 'detail' : 'list',
              error: '',
              notice: '',
            },
          };
        case 'Title':
          return { model: { ...model, title: message.value } };
        case 'ExpirePreset':
          return { model: { ...model, expirePreset: message.value } };
        case 'LimitPreset':
          return { model: { ...model, limitPreset: message.value } };
        case 'Expire':
          return { model: { ...model, expire: message.value } };
        case 'Limit':
          return { model: { ...model, limit: message.value } };
        case 'Approval':
          return { model: { ...model, requestNeeded: message.value } };
        case 'Save': {
          if (model.busy || !model.props.online) return { model };
          return run(
            Effect.sync(() => Math.floor(Date.now() / 1000)).pipe(
              Effect.flatMap((now) => {
                const duration = { hour: 3600, day: 86400, week: 604800 }[model.expirePreset];
                const draft: ChatInviteLinkDraft = {
                  title: model.title.trim(),
                  requestNeeded: model.requestNeeded,
                  expireDate: duration
                    ? now + duration
                    : model.expirePreset === 'custom' && model.expire
                      ? Math.floor(new Date(model.expire).getTime() / 1000)
                      : 0,
                  usageLimit:
                    model.requestNeeded || model.limitPreset === 'unlimited'
                      ? 0
                      : Number(model.limitPreset === 'custom' ? model.limit : model.limitPreset),
                };
                return model.selected
                  ? model.props.api
                      .editChatInviteLink(peer, model.selected.url, draft)
                      .pipe(Effect.as({ type: 'Done' } as Message))
                  : model.props.api
                      .exportChatInviteLink(peer, draft)
                      .pipe(Effect.map((link): Message => ({ type: 'Done', link })));
              }),
            ),
          );
        }
        case 'Confirm':
          return { model: { ...model, page: 'confirm', error: '' } };
        case 'Remove':
          return model.selected && !model.busy && model.props.online
            ? run(
                (model.selected.revoked
                  ? model.props.api.deleteChatInviteLink(peer, model.selected.url)
                  : model.props.api.revokeChatInviteLink(peer, model.selected.url)
                ).pipe(Effect.as({ type: 'Done' } as Message)),
              )
            : { model };
        case 'Done':
          return {
            model: {
              ...model,
              busy: false,
              page: message.link ? 'detail' : 'list',
              selected: message.link,
              notice: '',
            },
            commands: [
              {
                key: ['reload-links', peer.id],
                policy: 'replace',
                effect: Effect.succeed({ type: 'Load' } as Message),
              },
            ],
          };
        case 'Error':
          return { model: { ...model, loading: false, busy: false, error: message.error } };
        case 'Copy':
          return {
            model,
            commands: [
              {
                key: 'copy-link',
                policy: 'replace',
                effect: Effect.tryPromise(() => navigator.clipboard.writeText(message.url)).pipe(
                  Effect.match({
                    onSuccess: (): Message => ({ type: 'Copied' }),
                    onFailure: (): Message => ({
                      type: 'Error',
                      error: 'Could not copy the link. Select and copy it below.',
                    }),
                  }),
                ),
              },
            ],
          };
        case 'Copied':
          return { model: { ...model, notice: 'Link copied', error: '' } };
      }
    },
  },
  view((model, send) => {
    const props = model.props;
    const link = model.selected;
    const close = () => {
      if (!model.busy) props.close();
    };
    return (
      <Dialog
        title={
          model.page === 'edit'
            ? link
              ? 'Edit invitation link'
              : 'New invitation link'
            : model.page === 'confirm'
              ? link?.revoked
                ? 'Delete invitation link?'
                : 'Revoke invitation link?'
              : 'Invitation links'
        }
        class={`${panelClass} !max-w-[460px]`}
        onClose={close}
        headerLeading={
          model.page !== 'list' ? (
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
            kind: 'invite-links',
            online: props.online,
            reload: () => send({ type: 'Load' }),
          })}
        />
        <div class="invite-links-body scroll-area">
          {model.page === 'list' ? (
            <>
              <p class="text-sm text-muted">Your invitation links for {props.dialog.title}</p>
              <nav class="invite-link-tabs" aria-label="Invitation link status">
                <button
                  aria-pressed={!model.revoked}
                  onClick={() => send({ type: 'Tab', revoked: false })}
                >
                  Active
                </button>
                <button
                  aria-pressed={model.revoked}
                  onClick={() => send({ type: 'Tab', revoked: true })}
                >
                  Revoked
                </button>
              </nav>
              {!model.revoked ? (
                <button
                  class="folder-main text-accent"
                  disabled={!props.online}
                  onClick={() => send({ type: 'Edit' })}
                >
                  <Plus size={20} />
                  <span>Create a new link</span>
                </button>
              ) : null}
              {list(linkRows(model.links?.links ?? []), (item) => (
                <button class="invite-link-row" onClick={() => send({ type: 'Open', link: item })}>
                  <span class="invite-link-icon">
                    <Link size={20} />
                  </span>
                  <span>
                    <strong>
                      {item.title ||
                        (item.permanent ? 'Primary link' : item.url.replace('https://t.me/', ''))}
                    </strong>
                    <small>
                      {linkState(item, model.now)} · {item.usage} joined
                      {item.requested ? ` · ${item.requested} requested` : ''}
                    </small>
                  </span>
                  <ChevronRight size={18} />
                </button>
              ))}
              {model.loading ? (
                <p role="status">Loading links…</p>
              ) : model.links && !model.links.links.length ? (
                <p class="join-requests-empty">
                  {model.revoked ? 'No revoked links' : 'No invitation links yet'}
                </p>
              ) : null}
              {model.links?.nextOffset ? (
                <button
                  class="secondary-button"
                  disabled={model.loading || !props.online}
                  onClick={() => send({ type: 'Load', more: true })}
                >
                  Load more
                </button>
              ) : null}
            </>
          ) : model.page === 'edit' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                send({ type: 'Save' });
              }}
            >
              <label class="create-chat-field">
                <span>Link name (optional)</span>
                <input
                  value={model.title}
                  maxLength={32}
                  disabled={model.busy}
                  onInput={(event) => send({ type: 'Title', value: event.currentTarget.value })}
                />
              </label>
              <label class="invite-link-approval">
                <span>
                  Request admin approval
                  <small>People can join after an administrator approves their request.</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={model.requestNeeded}
                  disabled={model.busy}
                  onChange={(event) =>
                    send({ type: 'Approval', value: event.currentTarget.checked })
                  }
                />
              </label>
              <label class="create-chat-field">
                <span>Time limit</span>
                <select
                  value={model.expirePreset}
                  disabled={model.busy}
                  onChange={(event) =>
                    send({ type: 'ExpirePreset', value: event.currentTarget.value })
                  }
                >
                  {list(sequence(['never', 'hour', 'day', 'week', 'custom']), (value) => (
                    <option value={value}>
                      {
                        (
                          {
                            never: 'Never',
                            hour: '1 hour',
                            day: '1 day',
                            week: '1 week',
                            custom: 'Custom date',
                          } as Record<string, string>
                        )[value]
                      }
                    </option>
                  ))}
                </select>
              </label>
              {model.expirePreset === 'custom' ? (
                <label class="create-chat-field">
                  <span>Expiration date</span>
                  <input
                    type="datetime-local"
                    required
                    value={model.expire}
                    min={localDate(model.now + 60)}
                    disabled={model.busy}
                    onInput={(event) => send({ type: 'Expire', value: event.currentTarget.value })}
                  />
                </label>
              ) : null}
              {!model.requestNeeded ? (
                <>
                  <label class="create-chat-field">
                    <span>Usage limit</span>
                    <select
                      value={model.limitPreset}
                      disabled={model.busy}
                      onChange={(event) =>
                        send({ type: 'LimitPreset', value: event.currentTarget.value })
                      }
                    >
                      {list(sequence(['unlimited', '1', '10', '100', 'custom']), (value) => (
                        <option value={value}>
                          {value === 'unlimited'
                            ? 'Unlimited'
                            : value === 'custom'
                              ? 'Custom limit'
                              : value}
                        </option>
                      ))}
                    </select>
                  </label>
                  {model.limitPreset === 'custom' ? (
                    <label class="create-chat-field">
                      <span>Number of people</span>
                      <input
                        type="number"
                        min={1}
                        max={100000}
                        step={1}
                        required
                        value={model.limit}
                        disabled={model.busy}
                        onInput={(event) =>
                          send({ type: 'Limit', value: event.currentTarget.value })
                        }
                      />
                    </label>
                  ) : null}
                </>
              ) : null}
              <div class="folder-footer">
                <button
                  type="button"
                  class="secondary-button"
                  disabled={model.busy}
                  onClick={() => send({ type: 'Back' })}
                >
                  Cancel
                </button>
                <button type="submit" class="primary-button" disabled={model.busy || !props.online}>
                  {model.busy ? 'Saving…' : link ? 'Save' : 'Create link'}
                </button>
              </div>
            </form>
          ) : model.page === 'confirm' && link ? (
            <>
              <p>
                {link.revoked
                  ? 'Delete this revoked link from the list?'
                  : 'People will no longer be able to join using this link. Existing members will remain in the chat.'}
              </p>
              <div class="folder-footer">
                <button
                  class="secondary-button"
                  disabled={model.busy}
                  onClick={() => send({ type: 'Back' })}
                >
                  Cancel
                </button>
                <button
                  class="secondary-button text-red-400"
                  disabled={model.busy || !props.online}
                  onClick={() => send({ type: 'Remove' })}
                >
                  {model.busy ? 'Please wait…' : link.revoked ? 'Delete link' : 'Revoke link'}
                </button>
              </div>
            </>
          ) : link ? (
            <>
              <h2 class="font-semibold">
                {link.title || (link.permanent ? 'Primary link' : 'Invitation link')}
              </h2>
              <input
                class="invite-link-url"
                aria-label="Invitation URL"
                readOnly
                value={link.url}
                onFocus={(event) => event.currentTarget.select()}
              />
              <p class="text-sm text-muted">{linkState(link, model.now)}</p>
              <dl class="invite-link-stats">
                <div>
                  <dt>Joined</dt>
                  <dd>
                    {link.usage}
                    {link.usageLimit ? ` / ${link.usageLimit}` : ''}
                  </dd>
                </div>
                {link.requestNeeded ? (
                  <div>
                    <dt>Pending requests</dt>
                    <dd>{link.requested}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Expires</dt>
                  <dd>
                    {link.expireDate ? new Date(link.expireDate * 1000).toLocaleString() : 'Never'}
                  </dd>
                </div>
              </dl>
              <div class="folder-footer">
                <button
                  class="secondary-button"
                  onClick={() => send({ type: 'Copy', url: link.url })}
                >
                  Copy link
                </button>
                {!link.revoked && !link.permanent && !link.paid ? (
                  <button
                    class="primary-button"
                    disabled={!props.online}
                    onClick={() => send({ type: 'Edit', link })}
                  >
                    Edit link
                  </button>
                ) : null}
              </div>
              <button
                class="invite-link-danger"
                disabled={!props.online}
                onClick={() => send({ type: 'Confirm' })}
              >
                {link.revoked ? 'Delete link' : 'Revoke link'}
              </button>
            </>
          ) : null}
          {model.notice ? (
            <p role="status" class="text-sm text-accent">
              {model.notice}
            </p>
          ) : null}
          {model.error ? (
            <p role="alert" class="text-sm text-red-400">
              {model.error}
            </p>
          ) : null}
          {!props.online ? (
            <p role="status" class="text-sm text-muted">
              Connect to Telegram to manage invitation links.
            </p>
          ) : null}
        </div>
      </Dialog>
    );
  }),
);
