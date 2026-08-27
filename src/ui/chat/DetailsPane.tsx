import FileText from 'lucide-solid/icons/file-text';
import FileImage from 'lucide-solid/icons/file-image';
import Headphones from 'lucide-solid/icons/headphones';
import Image from 'lucide-solid/icons/image';
import Link from 'lucide-solid/icons/link';
import Mic from 'lucide-solid/icons/mic';
import Video from 'lucide-solid/icons/video';
import Hand from 'lucide-solid/icons/hand';
import PanelRightClose from 'lucide-solid/icons/panel-right-close';
import Pencil from 'lucide-solid/icons/pencil';
import Share2 from 'lucide-solid/icons/share-2';
import Trash2 from 'lucide-solid/icons/trash-2';
import { For, Show } from 'solid-js';

import type { ChatSummary } from '../../domain/models';
import type {
  SharedMediaCounts,
  SharedMediaKind,
  TelegramGroupMember,
  TelegramUserDetails,
} from '../../telegram/types';
import { AutoLinkText } from '../shared/AutoLinkText';
import { Avatar } from '../shared/Avatar';

interface DetailsPaneProps {
  chat: ChatSummary;
  counts?: SharedMediaCounts | undefined;
  userDetails?: TelegramUserDetails | undefined;
  members: TelegramGroupMember[];
  membersLoading: boolean;
  online: boolean;
  modal: boolean;
  avatarIdentity: string;
  loadCachedAvatar: () => Promise<string | undefined>;
  loadAvatar: () => Promise<string | undefined>;
  loadCachedMemberAvatar: (member: TelegramGroupMember) => Promise<string | undefined>;
  loadMemberAvatar: (member: TelegramGroupMember) => Promise<string | undefined>;
  close: () => void;
  openShared: (kind: SharedMediaKind) => void;
  shareContact: () => void;
  editContact: () => void;
  deleteContact: () => void;
  setBlocked: (blocked: boolean) => void;
}

export function DetailsPane(props: DetailsPaneProps) {
  const phone = () => {
    const value = props.userDetails?.phone;
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
    const value = props.userDetails?.birthday;
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
      class="details-pane min-h-0 min-w-0 border-l border-[var(--line)] bg-[var(--panel)]"
      role={props.modal ? 'dialog' : undefined}
      aria-modal={props.modal ? 'true' : undefined}
      aria-label={props.modal ? 'Chat details' : undefined}
      tabIndex={props.modal ? -1 : undefined}
    >
      <header class="details-header flex h-16 items-center justify-between border-b border-[var(--line)] px-4">
        <strong class="text-sm font-semibold">Info</strong>
        <button class="icon-button" onClick={props.close} aria-label="Close details">
          <PanelRightClose size={18} />
        </button>
      </header>
      <div class="scroll-area h-[calc(100%-4rem)] overflow-y-auto">
        <section class="flex flex-col items-center border-b border-[var(--line)] px-6 py-7 text-center">
          <div data-testid="details-avatar">
            <Avatar
              identity={props.avatarIdentity}
              initials={props.chat.initials}
              color={props.chat.color}
              size="lg"
              online={props.chat.presence === 'online'}
              loadCached={props.loadCachedAvatar}
              load={props.online ? props.loadAvatar : undefined}
            />
          </div>
          <h2 class="mt-4 font-semibold">{props.chat.title}</h2>
          <p class="mt-1 text-xs text-[var(--muted)]">{status()}</p>
        </section>
        <Show when={props.chat.kind === 'user' && props.userDetails}>
          <section class="profile-fields">
            <Show when={phone()}>
              <div>
                <span>{phone()}</span>
                <small>Mobile</small>
              </div>
            </Show>
            <Show when={props.userDetails?.bio}>
              <div>
                <AutoLinkText text={props.userDetails!.bio!} />
                <small>Bio</small>
              </div>
            </Show>
            <Show when={props.userDetails?.username}>
              <a
                href={`https://t.me/${props.userDetails!.username}`}
                target="_blank"
                rel="noreferrer"
              >
                <span>@{props.userDetails!.username}</span>
                <small>Username</small>
              </a>
            </Show>
            <Show when={birthday()}>
              <div>
                <span>{birthday()}</span>
                <small>Birthday</small>
              </div>
            </Show>
          </section>
        </Show>
        <section class="p-2">
          <button class="detail-row" onClick={() => props.openShared('photos')}>
            <Image size={17} />
            <span>Photos</span>
            <b>{props.counts?.photos ?? '…'}</b>
          </button>
          <button class="detail-row" onClick={() => props.openShared('videos')}>
            <Video size={17} />
            <span>Videos</span>
            <b>{props.counts?.videos ?? '…'}</b>
          </button>
          <button class="detail-row" onClick={() => props.openShared('files')}>
            <FileText size={17} />
            <span>Files</span>
            <b>{props.counts?.files ?? '…'}</b>
          </button>
          <button class="detail-row" onClick={() => props.openShared('audio')}>
            <Headphones size={17} />
            <span>Audio files</span>
            <b>{props.counts?.audio ?? '…'}</b>
          </button>
          <button class="detail-row" onClick={() => props.openShared('links')}>
            <Link size={17} />
            <span>Links</span>
            <b>{props.counts?.links ?? '…'}</b>
          </button>
          <button class="detail-row" onClick={() => props.openShared('voice')}>
            <Mic size={17} />
            <span>Voice messages</span>
            <b>{props.counts?.voice ?? '…'}</b>
          </button>
          <button class="detail-row" onClick={() => props.openShared('gifs')}>
            <FileImage size={17} />
            <span>GIFs</span>
            <b>{props.counts?.gifs ?? '…'}</b>
          </button>
        </section>
        <Show when={props.chat.kind === 'user' && props.userDetails}>
          <section class="contact-actions" aria-label="Contact actions">
            <button onClick={props.shareContact}>
              <Share2 size={17} />
              <span>Share this contact</span>
            </button>
            <Show when={props.userDetails?.isContact}>
              <button onClick={props.editContact}>
                <Pencil size={17} />
                <span>Edit contact</span>
              </button>
              <button onClick={props.deleteContact}>
                <Trash2 size={17} />
                <span>Delete contact</span>
              </button>
            </Show>
            <button class="danger" onClick={() => props.setBlocked(!props.userDetails?.blocked)}>
              <Hand size={17} />
              <span>{props.userDetails?.blocked ? 'Unblock user' : 'Block user'}</span>
            </button>
          </section>
        </Show>
        <Show when={props.chat.kind !== 'user'}>
          <section class="group-members" aria-label="Members">
            <header>
              <strong>Members</strong>
              <span>{props.membersLoading ? '…' : props.members.length}</span>
            </header>
            <Show
              when={!props.membersLoading}
              fallback={<p class="group-members-state">Loading members…</p>}
            >
              <For
                each={props.members}
                fallback={<p class="group-members-state">Members are unavailable.</p>}
              >
                {(member) => (
                  <div class="group-member">
                    <Avatar
                      identity={`${member.peer.id}:${member.avatarId ?? 'none'}`}
                      initials={member.initials}
                      color={member.color}
                      size="sm"
                      online={member.presence === 'online'}
                      loadCached={
                        member.hasAvatar ? () => props.loadCachedMemberAvatar(member) : undefined
                      }
                      load={
                        props.online && member.hasAvatar
                          ? () => props.loadMemberAvatar(member)
                          : undefined
                      }
                    />
                    <span>
                      <strong>{member.title}</strong>
                      <small>{memberStatus(member)}</small>
                    </span>
                    <Show when={member.role}>
                      <b class={`member-role ${member.roleKind ?? 'admin'}`}>{member.role}</b>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </section>
        </Show>
      </div>
    </aside>
  );
}
