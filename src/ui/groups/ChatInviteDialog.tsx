import { Effect } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { available, component, domBinding, resourceError, view } from 'effectweb';
import type { ChatInvitePreview, ChatInvitesApi, JoinedChat } from '../../telegram/chatManagement';
import type { TelegramPeer } from '../../telegram/types';
import { Dialog } from '../shared/Dialog';
import { Avatar } from '../shared/Avatar';
import { panelClass } from '../shared/panelStyles';
interface Props {
  hash: string;
  api: ChatInvitesApi;
  online: boolean;
  open: (peer: TelegramPeer, title: string) => Effect.Effect<void, unknown>;
  close: () => void;
}
function acquire(_root: HTMLElement, input: () => { key: string; load: () => void }) {
  let key = '';
  const update = () => {
    if (key !== input().key) {
      key = input().key;
      input().load();
    }
  };
  update();
  return { update, dispose() {} };
}
export const ChatInviteDialog = component(
  {
    identity: (props) => props.hash,
    init: (_props: Props) => ({
      preview: AsyncResult.initial() as AsyncResult.AsyncResult<ChatInvitePreview, unknown>,
      joined: AsyncResult.initial() as AsyncResult.AsyncResult<JoinedChat, unknown>,
    }),
  },
  (owner) =>
    view((model) => {
      const props = model.props;
      const preview = available(model.preview);
      const joined = available(model.joined);
      const busy = model.joined.waiting;
      const load = () => {
        if (props.online) owner.task('preview', props.api.checkChatInvite(props.hash), 'replace');
      };
      const enter = () => {
        if (!preview || busy) return;
        const action =
          preview.alreadyJoined && preview.peer
            ? Effect.succeed({ status: 'joined' as const, peer: preview.peer })
            : props.api.joinChatInvite(props.hash);
        owner.task(
          'joined',
          action.pipe(
            Effect.tap((result) =>
              result.status === 'joined' && result.peer
                ? props
                    .open(result.peer, preview.title)
                    .pipe(Effect.andThen(Effect.sync(props.close)))
                : Effect.void,
            ),
          ),
          'drop',
        );
      };
      const error = resourceError(model.preview) ?? resourceError(model.joined);
      return (
        <Dialog
          class={`${panelClass} !max-w-[420px]`}
          title={joined?.status === 'requested' ? 'Request sent' : 'Chat invitation'}
          onClose={() => {
            if (!busy) props.close();
          }}
        >
          <span hidden use={domBinding({ key: `${props.hash}:${props.online}`, load }, acquire)} />
          <div class="chat-invite-body">
            {preview ? (
              <>
                <Avatar
                  identity={preview.peer?.id ?? props.hash}
                  initials={preview.title.slice(0, 2).toUpperCase()}
                  color="#5288c1"
                  size="lg"
                />
                <h2>{preview.title}</h2>
                <p class="text-sm text-muted">
                  {preview.participantsCount.toLocaleString()}{' '}
                  {preview.broadcast ? 'subscribers' : 'members'}
                </p>
                {preview.about ? <p class="chat-invite-about">{preview.about}</p> : null}
                {joined?.status === 'requested' ? (
                  <p>
                    The administrators will review your request. The chat will appear in your list
                    when they approve it.
                  </p>
                ) : preview.requestNeeded ? (
                  <p class="text-sm text-muted">
                    An administrator must approve your request to join.
                  </p>
                ) : null}
                {preview.paid ? (
                  <p class="text-sm text-muted">
                    This channel requires a paid subscription. Open this invitation in Telegram to
                    review the payment.
                  </p>
                ) : null}
              </>
            ) : model.preview.waiting ? (
              <p role="status">Loading invitation…</p>
            ) : null}
            {error ? (
              <p role="alert" class="text-sm text-red-400">
                {error}
              </p>
            ) : null}
            {!props.online ? (
              <p role="status" class="text-sm text-muted">
                Connect to Telegram to open this invitation.
              </p>
            ) : null}
            <div class="folder-footer">
              <button class="secondary-button" disabled={busy} onClick={props.close}>
                {joined?.status === 'requested' ? 'Done' : 'Cancel'}
              </button>
              {preview && joined?.status !== 'requested' && !preview.paid ? (
                <button class="primary-button" disabled={busy || !props.online} onClick={enter}>
                  {busy
                    ? 'Please wait…'
                    : preview.alreadyJoined
                      ? 'Open chat'
                      : preview.requestNeeded
                        ? 'Request to join'
                        : preview.broadcast
                          ? 'Join channel'
                          : 'Join group'}
                </button>
              ) : null}
              {!preview && error ? (
                <button
                  class="primary-button"
                  disabled={!props.online || model.preview.waiting}
                  onClick={load}
                >
                  Try again
                </button>
              ) : null}
            </div>
            {preview?.paid || resourceError(model.joined) ? (
              <a
                class="text-sm text-accent"
                href={`https://t.me/+${props.hash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in Telegram
              </a>
            ) : null}
          </div>
        </Dialog>
      );
    }),
);
