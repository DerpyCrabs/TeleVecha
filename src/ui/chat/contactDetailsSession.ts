import { available, modelOwner } from 'effectweb';
import { infiniteQuery, infiniteResource } from '@effectweb/query';
import type { SessionContext } from '../app/sessionContext';
import { Context, Effect } from 'effect';
import { permissionsForDialog } from '../../telegram/core/chatPermissions';
import type { MessagingError } from '../../telegram/core/messagingError';
import type {
  TelegramDialog,
  TelegramGroupMemberPage,
  TelegramPeer,
  TelegramResourceInvalidation,
} from '../../telegram/types';
import type { UiEffectRunner, UiTaskRunner } from '../app/appRuntime';
import { subscribeAtUi } from '../app/appRuntime';
interface ContactDetailsSource {
  updateContact(
    peer: TelegramPeer,
    firstName: string,
    lastName: string,
    phone: string,
  ): Effect.Effect<unknown, MessagingError>;
  deleteContact(peer: TelegramPeer): Effect.Effect<unknown, MessagingError>;
  subscribeResources(
    listener: (event: TelegramResourceInvalidation) => void,
  ): Effect.Effect<Effect.Effect<void>, MessagingError>;
}

export interface GroupMemberSource {
  getGroupMembers(
    peer: TelegramPeer,
    limit?: number,
    offset?: number,
  ): Effect.Effect<TelegramGroupMemberPage, MessagingError>;
}
export const GroupMemberSource = Context.Service<GroupMemberSource>('ui/GroupMemberSource');
export const groupMembers = infiniteQuery({
  name: 'group-members',
  initial: 0,
  load: (args: { peer: TelegramPeer }, offset: number) =>
    Effect.flatMap(GroupMemberSource, (source) => source.getGroupMembers(args.peer, 50, offset)),
  next: (page, offset) =>
    page.hasMore ? (page.nextOffset ?? offset + page.members.length) : undefined,
});

/** Owns contact actions and the group-member catalog shown by the details pane. */
export function createContactDetailsSession(
  options: {
    source: ContactDetailsSource;
    runEffect: UiEffectRunner;
    runTask: UiTaskRunner;
    dialog: () => TelegramDialog | undefined;
    detailsOpen: () => boolean;
  },
  context: SessionContext<GroupMemberSource>,
) {
  const scope = modelOwner({});
  const members = scope.own(infiniteResource(context.cache, groupMembers));
  scope.own(members.subscribe(context.changed));
  let selected: TelegramPeer | undefined;
  let loadingMore = false;
  const userDetails = () => options.dialog()?.userDetails;
  const refresh = () => {
    const dialog = options.dialog();
    const peer =
      options.detailsOpen() &&
      dialog &&
      dialog.peer.kind !== 'user' &&
      permissionsForDialog(dialog).canViewMembers
        ? dialog.peer
        : undefined;
    selected = peer;
    members.select(peer ? { peer } : undefined);
  };
  scope.own(
    subscribeAtUi(
      options.runTask,
      options.source.subscribeResources((event) => {
        if (event.kind === 'group-members' && event.peerId === options.dialog()?.peer.id) {
          if (selected) context.cache.invalidateQuery(groupMembers.query, { peer: selected });
          refresh();
        }
      }),
    ),
  );
  const loadMoreMembers = () => {
    if (loadingMore) return;
    loadingMore = true;
    context.changed();
    void options
      .runEffect(members.fetchNextPage())
      .catch(() => undefined)
      .finally(() => {
        loadingMore = false;
        context.changed();
      });
  };
  const share = async () => {
    const dialog = options.dialog();
    if (!dialog) return;
    const details = userDetails();
    const url = details?.username ? `https://t.me/${details.username}` : undefined;
    const text = [dialog.title, details?.phone, url].filter(Boolean).join('\n');
    if (navigator.share) {
      await navigator.share({ title: dialog.title, text, ...(url ? { url } : {}) });
      return;
    }
    await navigator.clipboard.writeText(text);
  };
  const edit = () => {
    const dialog = options.dialog();
    const details = userDetails();
    if (!dialog || dialog.peer.kind !== 'user' || !details) return;
    const firstName = window.prompt('First name', details.firstName ?? dialog.title)?.trim();
    if (!firstName) return;
    const lastName = window.prompt('Last name', details.lastName ?? '')?.trim();
    if (lastName === undefined) return;
    const phone = window.prompt('Phone', details.phone ?? '')?.trim();
    if (phone === undefined) return;
    void options
      .runEffect(options.source.updateContact(dialog.peer, firstName, lastName, phone))
      .catch(() => undefined);
  };
  const add = () => {
    const dialog = options.dialog();
    const details = userDetails();
    if (!dialog || dialog.peer.kind !== 'user' || !details) return;
    const firstName = window.prompt('First name', details.firstName ?? dialog.title)?.trim();
    if (!firstName) return;
    const lastName = window.prompt('Last name', details.lastName ?? '')?.trim();
    if (lastName === undefined) return;
    const phone = window.prompt('Phone', details.phone ?? '')?.trim();
    if (phone === undefined) return;
    void options
      .runEffect(options.source.updateContact(dialog.peer, firstName, lastName, phone))
      .catch(() => undefined);
  };
  const remove = () => {
    const dialog = options.dialog();
    if (!dialog || dialog.peer.kind !== 'user') return;
    if (!window.confirm(`Delete ${dialog.title} from your contacts?`)) return;
    void options.runEffect(options.source.deleteContact(dialog.peer)).catch(() => undefined);
  };
  const actions = { loadMoreMembers, share, add, edit, remove };
  return {
    ...actions,
    refresh,
    dispose: () => scope.dispose(),
    snapshot: () => {
      const result = members.read();
      const data = available(result);
      const seen = new Set<string>();
      const loaded = (data?.pages ?? [])
        .flatMap((page) => page.value.members)
        .filter((member) => !seen.has(member.peer.id) && Boolean(seen.add(member.peer.id)));
      return {
        ...actions,
        userDetails: userDetails(),
        members: loaded,
        membersLoading: result.waiting && !data,
        membersTotal:
          data?.pages.at(-1)?.value.totalCount ??
          options.dialog()?.permissions?.memberCount ??
          loaded.length,
        membersHasMore: data?.next !== undefined,
        membersLoadingMore: loadingMore,
      };
    },
  };
}
export type ContactDetailsSession = ReturnType<
  ReturnType<typeof createContactDetailsSession>['snapshot']
>;
