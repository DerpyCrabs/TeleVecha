import FileText from 'lucide-solid/icons/file-text';
import Image from 'lucide-solid/icons/image';
import Link from 'lucide-solid/icons/link';
import PanelRightClose from 'lucide-solid/icons/panel-right-close';
import { Show } from 'solid-js';

import type { ChatSummary } from '../domain/models';
import type { SharedMediaCounts, SharedMediaKind, TelegramUserDetails } from '../telegram/types';
import { Avatar } from './Avatar';
import { AutoLinkText } from './AutoLinkText';

interface DetailsPaneProps {
  chat: ChatSummary;
  counts?: SharedMediaCounts | undefined;
  userDetails?: TelegramUserDetails | undefined;
  online: boolean;
  modal: boolean;
  avatarIdentity: string;
  loadCachedAvatar: () => Promise<string | undefined>;
  loadAvatar: () => Promise<string | undefined>;
  close: () => void;
  openShared: (kind: SharedMediaKind) => void;
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
          <Avatar
            identity={props.avatarIdentity}
            initials={props.chat.initials}
            color={props.chat.color}
            size="lg"
            online={props.chat.presence === 'online'}
            loadCached={props.loadCachedAvatar}
            load={props.online ? props.loadAvatar : undefined}
          />
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
          </section>
        </Show>
        <section class="p-2">
          <button class="detail-row" onClick={() => props.openShared('media')}>
            <Image size={17} />
            <span>Media</span>
            <b>{props.counts?.media ?? '…'}</b>
          </button>
          <button class="detail-row" onClick={() => props.openShared('files')}>
            <FileText size={17} />
            <span>Files</span>
            <b>{props.counts?.files ?? '…'}</b>
          </button>
          <button class="detail-row" onClick={() => props.openShared('links')}>
            <Link size={17} />
            <span>Links</span>
            <b>{props.counts?.links ?? '…'}</b>
          </button>
        </section>
      </div>
    </aside>
  );
}
