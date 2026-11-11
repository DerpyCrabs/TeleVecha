import { available, observe, list, view, type Source } from 'effectweb';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
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
  privateChat: boolean;
  online: boolean;
  source: Source<AsyncResult.AsyncResult<TelegramReadReceipts, unknown>>;
  open: (result: TelegramReadReceipts) => void;
  media: MediaAssets;
}
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
export const ReadReceiptMenuItem = view<Props>((props) =>
  observe(props.source, (state) => {
    const result = available(state);
    const canOpen = result?.state === 'available' && !props.privateChat && result.people.length > 0;
    const label =
      !props.online && !result
        ? 'Read receipts unavailable offline'
        : !result && AsyncResult.isFailure(state)
          ? 'Read receipts unavailable'
          : !result
            ? 'Checking read status…'
            : result.state !== 'available'
              ? unavailableText[result.state]
              : props.privateChat
                ? `Read ${readAtLabel(result.people[0]!.readAt)}`
                : `Read by ${result.people.length}`;
    return (
      <button
        role="menuitem"
        class="message-read-status"
        disabled={!canOpen}
        title={label}
        onClick={() => {
          if (canOpen && result) props.open(result);
        }}
      >
        <CheckCheck size={16} />
        <span>{label}</span>
        {canOpen ? (
          <>
            <span class="read-avatar-stack" aria-hidden="true">
              {list(idRows(result.people.slice(0, 3)), (person) => (
                <PersonAvatar person={person} media={props.media} online={props.online} small />
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
