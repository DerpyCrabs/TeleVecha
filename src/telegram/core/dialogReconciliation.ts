import type { TelegramDialog } from '../types';

interface CapturedDialogVersion {
  readonly version: number;
}

/**
 * Merges a fetched dialog without allowing a request that started earlier to
 * replace a dialog changed by a user action or live update in the meantime.
 */
export function reconcileFetchedDialog<T extends TelegramDialog>(
  fresh: T,
  current: TelegramDialog | undefined,
  changedWhileLoading: boolean,
): T {
  if (current && changedWhileLoading) return { ...fresh, ...current };
  return {
    ...fresh,
    ...(current?.channelPts !== undefined ? { channelPts: current.channelPts } : {}),
    ...(current?.userDetails ? { userDetails: current.userDetails } : {}),
    ...(fresh.presence === undefined && current?.presence !== undefined
      ? { presence: current.presence }
      : {}),
    ...(fresh.lastSeenAt === undefined && current?.lastSeenAt !== undefined
      ? { lastSeenAt: current.lastSeenAt }
      : {}),
  };
}

/** Preserves dialogs that appeared or changed after a page request began. */
export function reconcileDialogPage<T extends TelegramDialog>(
  fetched: readonly T[],
  current: readonly TelegramDialog[],
  captured: ReadonlyMap<string, CapturedDialogVersion>,
  versionOf: (peerId: string) => number,
): TelegramDialog[] {
  const currentById = new Map(current.map((dialog) => [dialog.peer.id, dialog]));
  const fetchedPeerIds = new Set(fetched.map(({ peer }) => peer.id));
  const merged = fetched.flatMap((fresh) => {
    const peerId = fresh.peer.id;
    const live = currentById.get(peerId);
    const before = captured.get(peerId);
    const changed = before ? versionOf(peerId) !== before.version : live !== undefined;
    if (changed && !live) return [];
    return [reconcileFetchedDialog(fresh, live, changed)];
  });
  const concurrent = current.filter(({ peer, transient }) => {
    if (fetchedPeerIds.has(peer.id)) return false;
    const before = captured.get(peer.id);
    return Boolean(transient || !before || versionOf(peer.id) !== before.version);
  });
  return [...merged, ...concurrent];
}
