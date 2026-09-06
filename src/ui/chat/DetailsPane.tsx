import type { ChatSummary } from '../../domain/models';
import type { SharedMediaCounts, SharedMediaKind, TelegramGroupMember } from '../../telegram/types';
import { peerRows } from '../collections';
import FileImage from '@effectweb/lucide/icons/file-image';
import FileText from '@effectweb/lucide/icons/file-text';
import Hand from '@effectweb/lucide/icons/hand';
import Headphones from '@effectweb/lucide/icons/headphones';
import Image from '@effectweb/lucide/icons/image';
import Link from '@effectweb/lucide/icons/link';
import Mic from '@effectweb/lucide/icons/mic';
import PanelRightClose from '@effectweb/lucide/icons/panel-right-close';
import Pencil from '@effectweb/lucide/icons/pencil';
import Share2 from '@effectweb/lucide/icons/share-2';
import Trash2 from '@effectweb/lucide/icons/trash-2';
import Video from '@effectweb/lucide/icons/video';
import type { MediaAssets } from '../media/mediaAssets';
import { view } from 'effectweb';
import { AutoLinkText } from '../shared/AutoLinkText';
import { Avatar } from '../shared/Avatar';
import type { ContactDetailsSession } from './contactDetailsSession';
interface DetailsPaneProps {
  chat: ChatSummary;
  counts?: SharedMediaCounts | undefined;
  online: boolean;
  conversationReady: boolean;
  modal: boolean;
  media: MediaAssets;
  details: ContactDetailsSession;
  close: () => void;
  openShared: (kind: SharedMediaKind) => void;
  setBlocked: (blocked: boolean) => void;
}
export const DetailsPane = view<DetailsPaneProps, never>((props, _send) => {
  const detailRowClass =
    'detail-row grid w-full grid-cols-[1.4rem_1fr_auto] items-center gap-2 rounded-[0.45rem] border-0 bg-transparent px-3 py-3 text-left text-[0.82rem] text-muted hover:bg-[var(--surface-subtle)] [&>span]:text-ink [&>b]:font-medium [&>b]:text-muted';
  const phone = () => {
    const value = props.details.userDetails?.phone;
    return value && !value.startsWith('+') ? `+${value}` : value;
  };
  const status = () => {
    if (props.chat.kind === 'channel') return 'channel';
    if (props.chat.kind === 'group') return 'group';
    if (props.chat.presence === 'online') return 'online';
    if (props.chat.lastSeenAt) {
      return `last seen ${new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(props.chat.lastSeenAt * 1000))}`;
    }
    if (props.chat.presence === 'recently') return 'last seen recently';
    if (props.chat.presence === 'offline') return 'offline';
    return props.chat.kind === 'user' ? 'status unavailable' : '';
  };
  const memberStatus = (member: TelegramGroupMember) => {
    if (member.presence === 'online') return 'online';
    if (member.presence === 'recently') return 'last seen recently';
    return 'offline';
  };
  const birthday = () => {
    const value = props.details.userDetails?.birthday;
    if (!value) return undefined;
    return new Intl.DateTimeFormat(undefined, {
      month: 'long',
      day: 'numeric',
      ...(value.year ? { year: 'numeric' as const } : {}),
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(value.year ?? 2000, value.month - 1, value.day)));
  };
  return (
    <aside
      class="details-pane min-h-0 min-w-0 border-l border-line bg-panel"
      role={props.modal ? 'dialog' : undefined}
      aria-modal={props.modal ? 'true' : undefined}
      aria-label={props.modal ? 'Chat details' : undefined}
      tabIndex={props.modal ? -1 : undefined}
    >
      <header class="details-header flex h-16 items-center justify-between border-b border-line px-4">
        <strong class="text-sm font-semibold">Info</strong>
        <button class="icon-button" onClick={props.close} aria-label="Close details">
          <PanelRightClose size={18} />
        </button>
      </header>
      <div class="scroll-area h-[calc(100%-4rem)] overflow-y-auto">
        <section class="flex flex-col items-center border-b border-line px-6 py-7 text-center">
          <div data-testid="details-avatar">
            <Avatar
              identity={props.media.avatarIdentity(props.chat.id)}
              initials={props.chat.initials}
              color={props.chat.color}
              size="lg"
              online={props.chat.presence === 'online'}
              loadCached={() => props.media.loadAvatar(props.chat.id, true)}
              load={props.online ? () => props.media.loadAvatar(props.chat.id) : undefined}
            />
          </div>
          <h2 class="mt-4 font-semibold">{props.chat.title}</h2>
          <p class="mt-1 text-xs text-[var(--muted)]">{status()}</p>
        </section>
        {props.chat.kind === 'user' && props.details.userDetails ? (
          <section class="grid gap-4 border-b border-line px-5 py-4 [&_a]:grid [&_a]:gap-1 [&_a]:text-ink [&_a]:no-underline [&_a>span]:text-[#65bff0] [&_div]:grid [&_div]:gap-1 [&_small]:text-xs [&_small]:text-muted [&_.autolink-text]:whitespace-pre-wrap [&_.autolink-text]:[overflow-wrap:anywhere] [&_.autolink-text_a]:inline [&_.autolink-text_a]:text-[#65bff0]">
            {phone() ? (
              <div>
                <span>{phone()}</span>
                <small>Mobile</small>
              </div>
            ) : null}
            {props.details.userDetails?.bio ? (
              <div>
                <AutoLinkText text={props.details.userDetails!.bio!} />
                <small>Bio</small>
              </div>
            ) : null}
            {props.details.userDetails?.username ? (
              <a
                href={`https://t.me/${props.details.userDetails!.username}`}
                target="_blank"
                rel="noreferrer"
              >
                <span>@{props.details.userDetails!.username}</span>
                <small>Username</small>
              </a>
            ) : null}
            {birthday() ? (
              <div>
                <span>{birthday()}</span>
                <small>Birthday</small>
              </div>
            ) : null}
          </section>
        ) : null}
        <section class="p-2">
          <button
            class={detailRowClass}
            disabled={!props.conversationReady}
            onClick={() => props.openShared('photos')}
          >
            <Image size={17} />
            <span>Photos</span>
            <b>{props.counts?.photos ?? '…'}</b>
          </button>
          <button
            class={detailRowClass}
            disabled={!props.conversationReady}
            onClick={() => props.openShared('videos')}
          >
            <Video size={17} />
            <span>Videos</span>
            <b>{props.counts?.videos ?? '…'}</b>
          </button>
          <button
            class={detailRowClass}
            disabled={!props.conversationReady}
            onClick={() => props.openShared('files')}
          >
            <FileText size={17} />
            <span>Files</span>
            <b>{props.counts?.files ?? '…'}</b>
          </button>
          <button
            class={detailRowClass}
            disabled={!props.conversationReady}
            onClick={() => props.openShared('audio')}
          >
            <Headphones size={17} />
            <span>Audio files</span>
            <b>{props.counts?.audio ?? '…'}</b>
          </button>
          <button
            class={detailRowClass}
            disabled={!props.conversationReady}
            onClick={() => props.openShared('links')}
          >
            <Link size={17} />
            <span>Links</span>
            <b>{props.counts?.links ?? '…'}</b>
          </button>
          <button
            class={detailRowClass}
            disabled={!props.conversationReady}
            onClick={() => props.openShared('voice')}
          >
            <Mic size={17} />
            <span>Voice messages</span>
            <b>{props.counts?.voice ?? '…'}</b>
          </button>
          <button
            class={detailRowClass}
            disabled={!props.conversationReady}
            onClick={() => props.openShared('gifs')}
          >
            <FileImage size={17} />
            <span>GIFs</span>
            <b>{props.counts?.gifs ?? '…'}</b>
          </button>
        </section>
        {props.chat.kind === 'user' && props.details.userDetails ? (
          <section
            class="grid border-y border-line px-2 py-2 [&>button]:grid [&>button]:w-full [&>button]:grid-cols-[1.4rem_minmax(0,1fr)] [&>button]:items-center [&>button]:gap-2 [&>button]:rounded-[0.45rem] [&>button]:border-0 [&>button]:bg-transparent [&>button]:px-3 [&>button]:py-2.5 [&>button]:text-left [&>button]:text-[0.82rem] [&>button]:text-ink [&>button:hover]:bg-[var(--surface-subtle)]"
            aria-label="Contact actions"
          >
            <button onClick={() => void props.details.share()}>
              <Share2 size={17} />
              <span>Share this contact</span>
            </button>
            {props.details.userDetails?.isContact ? (
              <>
                <button onClick={props.details.edit}>
                  <Pencil size={17} />
                  <span>Edit contact</span>
                </button>
                <button onClick={props.details.remove}>
                  <Trash2 size={17} />
                  <span>Delete contact</span>
                </button>
              </>
            ) : null}
            {!props.details.userDetails?.isContact ? (
              <button onClick={props.details.add}>
                <span aria-hidden="true" class="text-base leading-none">
                  +
                </span>
                <span>Add contact</span>
              </button>
            ) : null}
            <button
              class="!text-red-400"
              disabled={!props.conversationReady}
              onClick={() => props.setBlocked(!props.details.userDetails?.blocked)}
            >
              <Hand size={17} />
              <span>{props.details.userDetails?.blocked ? 'Unblock user' : 'Block user'}</span>
            </button>
          </section>
        ) : null}
        {props.chat.kind !== 'user' ? (
          <section class="group-members border-b border-line px-2.5 py-3" aria-label="Members">
            <header class="flex items-center justify-between px-2 py-1 pb-2.5 text-xs [&>span]:text-muted">
              <strong>Members</strong>
              <span>
                {props.details.membersLoading
                  ? '…'
                  : props.details.membersTotal || props.details.members.length}
              </span>
            </header>
            {!props.details.membersLoading ? (
              <>
                {peerRows(props.details.members).map((member) => (
                  <div class="group-member grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[0.55rem] px-2 py-2 hover:bg-[var(--surface-subtle)]">
                    <Avatar
                      identity={`${member.peer.id}:${member.avatarId ?? 'none'}`}
                      initials={member.initials}
                      color={member.color}
                      size="sm"
                      online={member.presence === 'online'}
                      loadCached={
                        member.hasAvatar
                          ? () =>
                              props.media.loadPeerAvatar(
                                member.peer,
                                member.hasAvatar,
                                member.avatarId,
                                true,
                              )
                          : undefined
                      }
                      load={
                        props.online && member.hasAvatar
                          ? () =>
                              props.media.loadPeerAvatar(
                                member.peer,
                                member.hasAvatar,
                                member.avatarId,
                              )
                          : undefined
                      }
                    />
                    <span class="grid min-w-0">
                      <strong class="truncate text-[0.8rem]">{member.title}</strong>
                      <small class="truncate text-[0.68rem] text-muted">
                        {memberStatus(member)}
                      </small>
                    </span>
                    {member.role ? (
                      <b
                        class="member-role rounded-full bg-[rgb(101_185_135/0.14)] px-1.5 py-0.5 text-[0.62rem] font-semibold text-[#65b987]"
                        classList={{
                          owner: member.roleKind === 'owner',
                          admin: member.roleKind === 'admin',
                          'bg-[rgb(168_121_232/0.14)] text-[#a879e8]': member.roleKind === 'owner',
                        }}
                      >
                        {member.role}
                      </b>
                    ) : null}
                  </div>
                ))}
                {props.details.membersHasMore ? (
                  <button
                    class="mt-1 w-full rounded-[0.45rem] border-0 bg-transparent px-2 py-2 text-xs text-muted hover:bg-[var(--surface-subtle)] hover:text-ink"
                    disabled={props.details.membersLoadingMore}
                    onClick={() => props.details.loadMoreMembers()}
                  >
                    {props.details.membersLoadingMore ? 'Loading…' : 'Load more members'}
                  </button>
                ) : null}
              </>
            ) : (
              <p class="m-0 px-2 py-3 text-xs text-muted">Loading members…</p>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
});
