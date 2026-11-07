import { component, domBinding, list, view, type Send, type Transition } from 'effectweb';
import { Effect } from 'effect';
import CheckCheck from '@effectweb/lucide/icons/check-check';
import ChevronRight from '@effectweb/lucide/icons/chevron-right';
import type { TelegramReadParticipant, TelegramReadReceipts } from '../../telegram/types';
import type { MediaAssets } from '../media/mediaAssets';
import { Avatar } from '../shared/Avatar';
import { Dialog } from '../shared/Dialog';
import { idRows } from '../collections';

export const readAtLabel = (date: number) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date * 1000));
const unavailableText: Record<Exclude<TelegramReadReceipts['state'], 'available'>, string> = {
  unread: 'Not read yet',
  expired: 'Read receipts have expired',
  privacy: 'Read time is hidden',
  'own-privacy': 'Read time is hidden by your privacy settings',
  'too-large': 'Read receipts are unavailable in large groups',
  unavailable: 'Read receipts are unavailable',
};
interface Props {
  identity: string;
  privateChat: boolean;
  online: boolean;
  load: () => Effect.Effect<TelegramReadReceipts, unknown>;
  open: (result: TelegramReadReceipts) => void;
  media: MediaAssets;
}
interface State {
  mounted: boolean;
  requested: string;
  data: TelegramReadReceipts | undefined;
  failed: boolean;
}
type Model = State & { readonly props: Props };
type Message =
  | { type: 'Load' }
  | { type: 'Loaded'; identity: string; data: TelegramReadReceipts | undefined };
function request(model: Model): Transition<Model, Message> {
  const identity = model.props.identity;
  if (!model.mounted || !model.props.online || model.requested === identity) return { model };
  return {
    model: { ...model, requested: identity, data: undefined, failed: false },
    cancel: model.requested ? [['read-receipts', model.requested]] : [],
    commands: [
      {
        key: ['read-receipts', identity],
        policy: 'replace',
        effect: Effect.suspend(model.props.load).pipe(
          Effect.matchCause({
            onSuccess: (data) => ({ type: 'Loaded', identity, data }) as const,
            onFailure: () => ({ type: 'Loaded', identity, data: undefined }) as const,
          }),
        ),
      },
    ],
  };
}
function acquireReadStatus(_element: HTMLElement, input: () => Send<Message>) {
  let notified: Send<Message> | undefined;
  const update = () => {
    const send = input();
    if (notified === send) return;
    notified = send;
    send({ type: 'Load' });
  };
  update();
  return { update, dispose: () => {} };
}
const readStatusMount = (send: Send<Message>) => domBinding(send, acquireReadStatus);
const PersonAvatar = view<{
  person: TelegramReadParticipant;
  media: MediaAssets;
  online: boolean;
  small?: boolean;
}>((props) => (
  <Avatar
    identity={`${props.person.id}:${props.person.avatarId ?? ''}`}
    initials={props.person.initials}
    color={props.person.color}
    size={props.small ? 'xs' : 'sm'}
    loadCached={
      props.person.hasAvatar
        ? () => props.media.loadPeerAvatar(props.person.peer, true, props.person.avatarId, true)
        : undefined
    }
    load={
      props.person.hasAvatar && props.online
        ? () => props.media.loadPeerAvatar(props.person.peer, true, props.person.avatarId)
        : undefined
    }
  />
));
export const ReadReceiptMenuItem = component<Props, State, Message>(
  {
    init: () => ({ mounted: false, requested: '', data: undefined, failed: false }),
    receive: request,
    update: (model, message) =>
      message.type === 'Load'
        ? request({ ...model, mounted: true })
        : message.identity !== model.requested
          ? { model }
          : { model: { ...model, data: message.data, failed: !message.data } },
  },
  view((model, send) => {
    const result = model.data;
    const canOpen =
      result?.state === 'available' && !model.props.privateChat && result.people.length > 0;
    const label = !model.props.online
      ? 'Read receipts unavailable offline'
      : model.failed
        ? 'Read receipts unavailable'
        : !result
          ? 'Checking read status…'
          : result.state !== 'available'
            ? unavailableText[result.state]
            : model.props.privateChat
              ? `Read ${readAtLabel(result.people[0]!.readAt)}`
              : `Read by ${result.people.length}`;
    return (
      <button
        role="menuitem"
        class="message-read-status"
        use={readStatusMount(send)}
        disabled={!canOpen}
        title={label}
        onClick={() => {
          if (canOpen && result) model.props.open(result);
        }}
      >
        <CheckCheck size={16} />
        <span>{label}</span>
        {canOpen ? (
          <>
            <span class="read-avatar-stack" aria-hidden="true">
              {list(idRows(result.people.slice(0, 3)), (person) => (
                <PersonAvatar
                  person={person}
                  media={model.props.media}
                  online={model.props.online}
                  small
                />
              ))}
            </span>
            <ChevronRight size={14} />
          </>
        ) : null}
      </button>
    );
  }),
);
export const ReadReceiptsDialog = view<{
  result: TelegramReadReceipts;
  media: MediaAssets;
  online: boolean;
  close: () => void;
  open: (person: TelegramReadParticipant) => void;
}>((props) => (
  <Dialog
    title={`Read by ${props.result.people.length}`}
    onClose={props.close}
    class="read-receipts-dialog"
  >
    <div class="read-receipts-list">
      {list(idRows(props.result.people), (person) => (
        <button
          class="read-receipt-person"
          disabled={!person.peer.accessHash}
          onClick={() => props.open(person)}
          title={`${person.name} · ${readAtLabel(person.readAt)}`}
        >
          <PersonAvatar person={person} media={props.media} online={props.online} />
          <span>
            <strong>{person.name}</strong>
            <time dateTime={new Date(person.readAt * 1000).toISOString()}>
              {readAtLabel(person.readAt)}
            </time>
          </span>
        </button>
      ))}
    </div>
  </Dialog>
));
