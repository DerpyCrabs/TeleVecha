import type { Effect } from 'effect';
import type {
  TelegramDialog,
  TelegramPeer,
  TelegramPeerSearchResult,
  TelegramResourceInvalidation,
} from './types';

export const folderCategories = [
  'contacts',
  'nonContacts',
  'groups',
  'broadcasts',
  'bots',
] as const;
export const folderExclusions = ['excludeMuted', 'excludeRead', 'excludeArchived'] as const;
export type FolderCategory = (typeof folderCategories)[number];
export type FolderExclusion = (typeof folderExclusions)[number];
export interface TelegramChatFolder {
  id: number;
  title: string;
  emoticon?: string | undefined;
  color?: number | undefined;
  shared: boolean;
  categories: FolderCategory[];
  exclusions: FolderExclusion[];
  pinned: TelegramPeer[];
  included: TelegramPeer[];
  excluded: TelegramPeer[];
}
export interface TelegramFolderLink {
  title: string;
  url: string;
  peers: TelegramPeer[];
}
export interface TelegramFolderInvite {
  slug: string;
  title: string;
  folderId?: number | undefined;
  peers: TelegramPeerSearchResult[];
  already: string[];
}
export interface ChatFoldersApi {
  getChatFolders(): Effect.Effect<TelegramChatFolder[], unknown>;
  saveChatFolder(folder: TelegramChatFolder): Effect.Effect<void, unknown>;
  deleteChatFolder(id: number): Effect.Effect<void, unknown>;
  reorderChatFolders(ids: number[]): Effect.Effect<void, unknown>;
  getFolderUpdates(id: number): Effect.Effect<TelegramFolderInvite, unknown>;
  joinFolderUpdates(id: number, peers: TelegramPeer[]): Effect.Effect<void, unknown>;
  getFolderLinks(id: number): Effect.Effect<TelegramFolderLink[], unknown>;
  exportFolderLink(
    id: number,
    title: string,
    peers: TelegramPeer[],
  ): Effect.Effect<TelegramFolderLink, unknown>;
  deleteFolderLink(id: number, slug: string): Effect.Effect<void, unknown>;
  checkFolderInvite(slug: string): Effect.Effect<TelegramFolderInvite, unknown>;
  joinFolderInvite(slug: string, peers: TelegramPeer[]): Effect.Effect<void, unknown>;
  subscribeResources(
    listener: (event: TelegramResourceInvalidation) => void,
  ): Effect.Effect<Effect.Effect<void>, unknown>;
}
export function folderContains(folder: TelegramChatFolder, dialog: TelegramDialog): boolean {
  const id = dialog.peer.id;
  if (folder.excluded.some((peer) => peer.id === id)) return false;
  if ([...folder.included, ...folder.pinned].some((peer) => peer.id === id)) return true;
  if (folder.exclusions.includes('excludeArchived') && dialog.archived) return false;
  if (folder.exclusions.includes('excludeMuted') && dialog.muted) return false;
  if (
    folder.exclusions.includes('excludeRead') &&
    !dialog.unreadCount &&
    !dialog.unreadMark &&
    !dialog.unreadMentionsCount &&
    !dialog.unreadReactionsCount
  )
    return false;
  const category: FolderCategory = dialog.bot
    ? 'bots'
    : dialog.peer.kind === 'user'
      ? dialog.isContact
        ? 'contacts'
        : 'nonContacts'
      : dialog.broadcast
        ? 'broadcasts'
        : 'groups';
  return folder.categories.includes(category);
}
export function folderInviteSlug(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.port || url.hash) return undefined;
    if (url.protocol === 'tg:' && url.hostname === 'addlist') {
      if (url.pathname && url.pathname !== '/') return undefined;
      if (
        [...url.searchParams.keys()].some((key) => key !== 'slug') ||
        url.searchParams.getAll('slug').length !== 1
      )
        return undefined;
      const slug = url.searchParams.get('slug');
      return slug && /^[\w-]+$/.test(slug) ? slug : undefined;
    }
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      [
        't.me',
        'www.t.me',
        'telegram.me',
        'www.telegram.me',
        'telegram.dog',
        'www.telegram.dog',
      ].includes(url.hostname) &&
      !url.search &&
      /^\/addlist\/[\w-]+\/?$/.test(url.pathname)
    )
      return url.pathname.split('/')[2];
  } catch {
    /* The editor also accepts the slug copied from a Telegram link. */
  }
  return /^[\w-]+$/.test(value.trim()) ? value.trim() : undefined;
}
