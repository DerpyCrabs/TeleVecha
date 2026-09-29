import { available, lifetime } from 'effectweb';
import { pages } from 'effectweb/advanced';
import type { SessionContext } from '../app/sessionContext';
import { Effect } from 'effect';
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
  getGroupMembers(
    peer: TelegramPeer,
    limit?: number,
    offset?: number,
  ): Effect.Effect<TelegramGroupMemberPage, MessagingError>;
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

/** Owns contact actions and the group-member catalog shown by the details pane. */
export function createContactDetailsSession(
  options: {
    source: ContactDetailsSource;
    runEffect: UiEffectRunner;
    runTask: UiTaskRunner;
    dialog: () => TelegramDialog | undefined;
    detailsOpen: () => boolean;
  },
  context: SessionContext,
) {
  const scope = lifetime();
  let memberRevision = 0;
  type Input = { peer: TelegramPeer | undefined; revision: number };
  const members = pages<Input, TelegramGroupMemberPage['members'][number], number>({
    key: ({ peer, revision }) =>
      peer ? `${peer.id}:${peer.accessHash ?? ''}:${revision}` : undefined,
    itemKey: (member) => member.peer.id,
    load: ({ peer }, offset) =>
      options.source
        .getGroupMembers(peer!, 50, offset)
        .pipe(
          Effect.map((page) => ({
            items: page.members,
            totalCount: page.totalCount,
            next: page.hasMore
              ? (page.nextOffset ?? (offset ?? 0) + page.members.length)
              : undefined,
          })),
        ),
  }).create({ peer: undefined, revision: 0 });
  scope.add(members.dispose);
  scope.add(members.subscribe(context.changed));
  scope.add(
    context.cache.onReset(() => {
      members.receive({ peer: undefined, revision: memberRevision });
    }),
  );
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
    members.receive({ peer, revision: memberRevision });
  };
  scope.add(
    subscribeAtUi(
      options.runTask,
      options.source.subscribeResources((event) => {
        if (event.kind === 'group-members' && event.peerId === options.dialog()?.peer.id) {
          memberRevision++;
          refresh();
        }
      }),
    ),
  );
  const loadMoreMembers = () => members.send({ type: 'More' });
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
      const result = members.model().result;
      const page = available(result);
      return {
        ...actions,
        userDetails: userDetails(),
        members: page?.items ?? [],
        membersLoading: result.waiting && !page,
        membersTotal:
          page?.totalCount ?? options.dialog()?.permissions?.memberCount ?? page?.items.length ?? 0,
        membersHasMore: page?.next !== undefined,
        membersLoadingMore: result.waiting && Boolean(page),
      };
    },
  };
}
export type ContactDetailsSession = ReturnType<
  ReturnType<typeof createContactDetailsSession>['snapshot']
>;
