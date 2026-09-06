import type { EffectMessagingClient } from '../../telegram/core/client';
import type {
  TelegramDeleteDialogAction,
  TelegramDialog,
  TelegramPeerSearchResult,
} from '../../telegram/types';
import type { UiEffectRunner } from '../app/appRuntime';
import type { Read } from 'effectweb/session';
type DirectorySource = Pick<
  EffectMessagingClient,
  | 'searchPeers'
  | 'addPeer'
  | 'getUserDetails'
  | 'setMuted'
  | 'setBlocked'
  | 'setPinnedDialog'
  | 'setArchived'
  | 'deleteDialog'
>;

/** Owns peer lookup and chat-list commands, including stale remote-search selection. */
export function createChatDirectory(
  source: DirectorySource,
  runEffect: UiEffectRunner,
  dialogs: Read<TelegramDialog[]>,
  selectPeer: (peerId: string) => Promise<boolean>,
) {
  let openGeneration = 0;
  const dialog = (peerId: string) => {
    const current = dialogs().find(({ peer }) => peer.id === peerId);
    if (!current) throw new Error('Chat is no longer available.');
    return current;
  };
  return {
    search: (query: string) => source.searchPeers(query),
    select(peerId: string) {
      openGeneration += 1;
      return selectPeer(peerId);
    },
    async open(result: TelegramPeerSearchResult) {
      const generation = ++openGeneration;
      await runEffect(source.addPeer(result));
      if (generation !== openGeneration) return false;
      return selectPeer(result.peer.id);
    },
    cachedDetails: (peerId: string) =>
      dialogs().find(({ peer }) => peer.id === peerId)?.userDetails,
    details: (peerId: string) => source.getUserDetails(dialog(peerId).peer),
    setMuted: (peerId: string, muted: boolean) =>
      runEffect(source.setMuted(dialog(peerId).peer, muted)),
    setBlocked: (peerId: string, blocked: boolean) =>
      runEffect(source.setBlocked(dialog(peerId).peer, blocked)),
    setPinned: (peerId: string, pinned: boolean) =>
      runEffect(source.setPinnedDialog(dialog(peerId).peer, pinned)),
    setArchived: (peerId: string, archived: boolean) =>
      runEffect(source.setArchived(dialog(peerId).peer, archived)),
    delete: (peerId: string, action: TelegramDeleteDialogAction) =>
      runEffect(source.deleteDialog(dialog(peerId).peer, action)),
  };
}
export type ChatDirectory = ReturnType<typeof createChatDirectory>;
