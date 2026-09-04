import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  type Accessor,
} from 'solid-js';
import type { Effect } from 'effect';

import type {
  TelegramDialog,
  TelegramGroupMemberPage,
  TelegramPeer,
  TelegramResourceInvalidation,
} from '../../telegram/types';
import type { MessagingError } from '../../telegram/core/messagingError';
import { permissionsForDialog } from '../../telegram/core/chatPermissions';
import { subscribeAtUi, type UiEffectRunner } from '../app/appRuntime';

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
export function createContactDetailsSession(options: {
  source: ContactDetailsSource;
  runEffect: UiEffectRunner;
  dialog: Accessor<TelegramDialog | undefined>;
  detailsOpen: Accessor<boolean>;
}) {
  const [memberRevision, setMemberRevision] = createSignal(0);
  onCleanup(
    subscribeAtUi(
      options.runEffect,
      options.source.subscribeResources((event) => {
        if (event.kind === 'group-members' && event.peerId === options.dialog()?.peer.id) {
          setMemberRevision((revision) => revision + 1);
        }
      }),
    ),
  );
  const userDetails = () => options.dialog()?.userDetails;
  const memberRequest = createMemo(() => {
    const revision = memberRevision();
    const dialog = options.dialog();
    if (
      !options.detailsOpen() ||
      !dialog ||
      dialog.peer.kind === 'user' ||
      !permissionsForDialog(dialog).canViewMembers
    )
      return false;
    return { key: `${dialog.peer.id}:${revision}`, peer: dialog.peer };
  });
  const [additionalMembers, setAdditionalMembers] = createSignal<
    import('../../telegram/types').TelegramGroupMember[]
  >([]);
  const [memberContinuation, setMemberContinuation] = createSignal<
    Omit<TelegramGroupMemberPage, 'members'> | undefined
  >();
  const [loadingMoreMembers, setLoadingMoreMembers] = createSignal(false);
  createEffect(
    on(memberRequest, () => {
      setAdditionalMembers([]);
      setMemberContinuation(undefined);
      setLoadingMoreMembers(false);
    }),
  );
  const [loadedMembers] = createResource(memberRequest, async ({ key, peer }) => ({
    key,
    page: await options
      .runEffect(options.source.getGroupMembers(peer))
      .catch((): TelegramGroupMemberPage => ({ members: [], totalCount: 0, hasMore: false })),
  }));
  const currentMemberPage = () => {
    const request = memberRequest();
    const loaded = loadedMembers();
    return request && loaded?.key === request.key
      ? { ...loaded.page, ...memberContinuation() }
      : undefined;
  };
  const members = () => {
    const page = currentMemberPage();
    if (!page) return [];
    const seen = new Set(page.members.map(({ peer }) => peer.id));
    return [...page.members, ...additionalMembers().filter(({ peer }) => !seen.has(peer.id))];
  };
  const membersLoading = () => Boolean(memberRequest()) && loadedMembers.loading;
  const membersTotal = () =>
    currentMemberPage()?.totalCount ?? options.dialog()?.permissions?.memberCount ?? 0;
  const membersHasMore = () => Boolean(currentMemberPage()?.hasMore);
  const loadMoreMembers = async () => {
    const request = memberRequest();
    const page = currentMemberPage();
    if (!request || !page?.hasMore || loadingMoreMembers()) return;
    setLoadingMoreMembers(true);
    try {
      const next = await options.runEffect(
        options.source.getGroupMembers(request.peer, 50, page.nextOffset ?? members().length),
      );
      setAdditionalMembers((current) => [
        ...current,
        ...next.members.filter(
          ({ peer }) =>
            !current.some((member) => member.peer.id === peer.id) &&
            !page.members.some((member) => member.peer.id === peer.id),
        ),
      ]);
      setMemberContinuation({
        totalCount: next.totalCount,
        hasMore: next.hasMore,
        ...(next.nextOffset === undefined ? {} : { nextOffset: next.nextOffset }),
      });
    } catch {
      // The next attempt can retry the same page without changing the loaded catalog.
    } finally {
      setLoadingMoreMembers(false);
    }
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

  return {
    userDetails,
    members,
    membersLoading,
    membersTotal,
    membersHasMore,
    membersLoadingMore: loadingMoreMembers,
    loadMoreMembers,
    share,
    add,
    edit,
    remove,
  };
}

export type ContactDetailsSession = ReturnType<typeof createContactDetailsSession>;
