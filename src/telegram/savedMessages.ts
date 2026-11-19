import type { TelegramMessage, TelegramPeer } from './types';
export interface SavedMessagesInfo {
  peer: TelegramPeer;
  premium: boolean;
}
export interface SavedDialog {
  peer: TelegramPeer;
  title: string;
  initials: string;
  color: string;
  hasAvatar: boolean;
  avatarId?: string | undefined;
  pinned: boolean;
  topMessage?: TelegramMessage | undefined;
}
export interface SavedDialogsOffset {
  peer: TelegramPeer;
  messageId: number;
  date: number;
}
export interface SavedDialogsPage {
  dialogs: SavedDialog[];
  nextOffset?: SavedDialogsOffset | undefined;
}
export interface SavedReactionTag {
  reaction: string;
  title: string;
  count: number;
}
export interface SavedTags {
  tags: SavedReactionTag[];
  recommended: string[];
}
export function savedReactionValid(reaction: string) {
  return reaction.startsWith('custom:')
    ? /^custom:[1-9][0-9]{0,18}$/.test(reaction) && BigInt(reaction.slice(7)) <= 0x7fffffffffffffffn
    : reaction.trim().length > 0 && reaction.length <= 64;
}
export function savedDraftKey(selfId: string, source?: TelegramPeer) {
  return source && source.id !== selfId ? `${selfId}/saved/${source.id}` : selfId;
}
export function messageInSavedDialog(message: TelegramMessage, sourceId: string) {
  return (message.savedPeerId ?? message.peerId) === sourceId;
}
