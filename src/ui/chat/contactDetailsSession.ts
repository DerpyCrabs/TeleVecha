import { createMemo, createResource, createSignal, onCleanup, type Accessor } from 'solid-js';

import type {
  TelegramDialog,
  TelegramGroupMember,
  TelegramPeer,
  TelegramResourceInvalidation,
} from '../../telegram/types';

interface ContactDetailsSource {
  getGroupMembers(peer: TelegramPeer): Promise<TelegramGroupMember[]>;
  updateContact(
    peer: TelegramPeer,
    firstName: string,
    lastName: string,
    phone: string,
  ): Promise<unknown>;
  deleteContact(peer: TelegramPeer): Promise<unknown>;
  subscribeResources(listener: (event: TelegramResourceInvalidation) => void): () => void;
}

/** Owns contact actions and the group-member catalog shown by the details pane. */
export function createContactDetailsSession(options: {
  source: ContactDetailsSource;
  dialog: Accessor<TelegramDialog | undefined>;
  detailsOpen: Accessor<boolean>;
}) {
  const [memberRevision, setMemberRevision] = createSignal(0);
  onCleanup(
    options.source.subscribeResources((event) => {
      if (event.kind === 'group-members' && event.peerId === options.dialog()?.peer.id) {
        setMemberRevision((revision) => revision + 1);
      }
    }),
  );
  const userDetails = () => options.dialog()?.userDetails;
  const memberRequest = createMemo(() => {
    const revision = memberRevision();
    const dialog = options.dialog();
    if (!options.detailsOpen() || !dialog || dialog.peer.kind === 'user') return false;
    return { key: `${dialog.peer.id}:${revision}`, peer: dialog.peer };
  });
  const [loadedMembers] = createResource(memberRequest, async ({ key, peer }) => ({
    key,
    members: await options.source.getGroupMembers(peer).catch(() => []),
  }));
  const members = () => {
    const request = memberRequest();
    const loaded = loadedMembers();
    return request && loaded?.key === request.key ? loaded.members : [];
  };
  const membersLoading = () => Boolean(memberRequest()) && loadedMembers.loading;

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
    void options.source
      .updateContact(dialog.peer, firstName, lastName, phone)
      .catch(() => undefined);
  };

  const remove = () => {
    const dialog = options.dialog();
    if (!dialog || dialog.peer.kind !== 'user') return;
    if (!window.confirm(`Delete ${dialog.title} from your contacts?`)) return;
    void options.source.deleteContact(dialog.peer).catch(() => undefined);
  };

  return { userDetails, members, membersLoading, share, edit, remove };
}

export type ContactDetailsSession = ReturnType<typeof createContactDetailsSession>;
