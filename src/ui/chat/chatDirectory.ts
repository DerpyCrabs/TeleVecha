import type { Accessor } from 'solid-js';

import type { MessagingClient } from '../../telegram/core/client';
import type { TelegramDialog, TelegramPeerSearchResult } from '../../telegram/types';

type DirectorySource = Pick<
  MessagingClient,
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
export class ChatDirectory {
  private openGeneration = 0;

  constructor(
    private readonly source: DirectorySource,
    private readonly dialogs: Accessor<TelegramDialog[]>,
    private readonly selectPeer: (peerId: string) => Promise<boolean>,
  ) {}

  private dialog(peerId: string) {
    const dialog = this.dialogs().find(({ peer }) => peer.id === peerId);
    if (!dialog) throw new Error('Chat is no longer available.');
    return dialog;
  }

  search(query: string) {
    return this.source.searchPeers(query);
  }

  select(peerId: string) {
    this.openGeneration += 1;
    return this.selectPeer(peerId);
  }

  async open(result: TelegramPeerSearchResult) {
    const generation = ++this.openGeneration;
    await this.source.addPeer(result);
    if (generation !== this.openGeneration) return false;
    return this.selectPeer(result.peer.id);
  }

  details(peerId: string) {
    return this.source.getUserDetails(this.dialog(peerId).peer);
  }

  setMuted(peerId: string, muted: boolean) {
    return this.source.setMuted(this.dialog(peerId).peer, muted);
  }

  setBlocked(peerId: string, blocked: boolean) {
    return this.source.setBlocked(this.dialog(peerId).peer, blocked);
  }

  setPinned(peerId: string, pinned: boolean) {
    return this.source.setPinnedDialog(this.dialog(peerId).peer, pinned);
  }

  setArchived(peerId: string, archived: boolean) {
    return this.source.setArchived(this.dialog(peerId).peer, archived);
  }

  delete(peerId: string) {
    return this.source.deleteDialog(this.dialog(peerId).peer);
  }
}
