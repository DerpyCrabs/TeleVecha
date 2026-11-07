import { Effect } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import {
  available,
  collection,
  component,
  domBinding,
  list,
  Portal,
  resourceError,
  view,
} from 'effectweb';
import Search from '@effectweb/lucide/icons/search';
import X from '@effectweb/lucide/icons/x';
import type { TelegramGroupMember, TelegramGroupMemberPage } from '../../telegram/types';
import type { MediaAssets } from '../media/mediaAssets';
import { Avatar } from '../shared/Avatar';
import { modalMount } from '../shared/modalMount';

const memberRows = collection((member: TelegramGroupMember) => member.peer.id);
function loadOnMount(_element: HTMLElement, input: () => { peerId: string; load: () => void }) {
  let loaded: string | undefined;
  const update = () => {
    const value = input();
    if (loaded !== value.peerId) {
      loaded = value.peerId;
      value.load();
    }
  };
  update();
  return { update, dispose() {} };
}

export const GroupSenderPicker = component(
  {
    identity: (props) => props.peerId,
    init: (_props: {
      peerId: string;
      media: MediaAssets;
      online: boolean;
      search: (query: string, offset: number) => Effect.Effect<TelegramGroupMemberPage, unknown>;
      select: (member: TelegramGroupMember) => void;
      close: () => void;
    }) => ({
      query: '',
      page: AsyncResult.initial() as AsyncResult.AsyncResult<TelegramGroupMemberPage, unknown>,
    }),
  },
  (owner) =>
    view((model) => {
      const props = model.props;
      const page = available(model.page);
      const load = (query: string, offset = 0) => {
        const previous = offset ? (page?.members ?? []) : [];
        if (!offset) owner.patch({ query, page: AsyncResult.initial() });
        owner.task(
          'page',
          Effect.sleep(query && !offset ? 180 : 0).pipe(
            Effect.andThen(() => props.search(query.trim(), offset)),
            Effect.map((next) => ({
              ...next,
              members: [
                ...new Map(
                  [...previous, ...next.members].map((member) => [member.peer.id, member]),
                ).values(),
              ],
            })),
          ),
          'replace',
        );
      };
      return (
        <Portal>
          <div
            class="forward-overlay"
            style={{ zIndex: 90 }}
            role="presentation"
            tabIndex={-1}
            use={modalMount(props.close)}
            onPointerDown={(event) => event.target === event.currentTarget && props.close()}
          >
            <div class="forward-dialog" role="dialog" aria-modal="true" aria-label="Choose sender">
              <span
                hidden
                use={domBinding({ peerId: props.peerId, load: () => load('') }, loadOnMount)}
              />
              <header>
                <strong>Choose sender</strong>
                <button
                  type="button"
                  onClick={props.close}
                  title="Close sender picker"
                  aria-label="Close sender picker"
                >
                  <X size={17} />
                </button>
              </header>
              <label class="mx-3 my-2 flex items-center gap-2 rounded-lg border border-line bg-black/10 px-3 py-2 text-muted">
                <Search size={16} />
                <input
                  autofocus
                  type="search"
                  class="min-w-0 flex-1 border-0 bg-transparent text-ink outline-none"
                  value={model.query}
                  placeholder="Search group members"
                  aria-label="Search group members"
                  onInput={(event) => load(event.currentTarget.value)}
                />
              </label>
              <div>
                {list(memberRows.from(page?.members ?? []), (member) => (
                  <button
                    type="button"
                    class="flex w-full items-center gap-3"
                    onClick={() => props.select(member)}
                    title={member.username ? `${member.title} · @${member.username}` : member.title}
                  >
                    <Avatar
                      identity={`sender:${member.peer.id}:${member.avatarId ?? 'none'}`}
                      initials={member.initials}
                      color={member.color}
                      size="sm"
                      loadCached={
                        member.hasAvatar
                          ? () =>
                              props.media.loadPeerAvatar(member.peer, true, member.avatarId, true)
                          : undefined
                      }
                      load={
                        props.online && member.hasAvatar
                          ? () => props.media.loadPeerAvatar(member.peer, true, member.avatarId)
                          : undefined
                      }
                    />
                    <span class="min-w-0 flex-1 text-left">
                      <span class="block truncate">{member.isSelf ? 'You' : member.title}</span>
                      {member.username ? (
                        <small class="block truncate text-muted">@{member.username}</small>
                      ) : null}
                    </span>
                  </button>
                ))}
                {model.page.waiting ? (
                  <p class="px-3 py-2 text-sm text-muted" role="status">
                    Searching members…
                  </p>
                ) : null}
                {resourceError(model.page) ? (
                  <p class="px-3 py-2 text-sm" role="alert">
                    Could not load group members.{' '}
                    <button type="button" onClick={() => load(model.query, page?.nextOffset ?? 0)}>
                      Try again
                    </button>
                  </p>
                ) : null}
                {page && !page.members.length && !model.page.waiting ? (
                  <p class="px-3 py-2 text-sm text-muted">No members found</p>
                ) : null}
                {page?.hasMore && page.nextOffset !== undefined && !resourceError(model.page) ? (
                  <button
                    type="button"
                    disabled={model.page.waiting}
                    onClick={() => load(model.query, page.nextOffset)}
                  >
                    Show more members
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </Portal>
      );
    }),
);
