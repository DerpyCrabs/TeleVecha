import { Effect } from 'effect';
import type { MtprotoClient } from '../mtproto';
import { Api, type Tl } from '../mtproto/tl';
import type { MtprotoError } from '../mtproto/errors';
import type { TelegramChatFolder, TelegramFolderInvite, TelegramFolderLink } from '../chatFolders';
import { folderCategories, folderExclusions } from '../chatFolders';
import type { TelegramPeer, TelegramPeerSearchResult } from '../types';

export function chatFolderMethods(context: {
  client: Effect.Effect<MtprotoClient, MtprotoError>;
  toInputPeer(peer: TelegramPeer): Tl.TypeInputPeer;
  self(): TelegramPeer | undefined;
  peer(peer: Tl.TypePeer): TelegramPeer | undefined;
  person(peer: Tl.TypePeer): TelegramPeerSearchResult | undefined;
  remember(users: readonly Tl.TypeUser[], chats: readonly Tl.TypeChat[]): void;
}) {
  const inputPeer = (peer: Tl.TypeInputPeer): TelegramPeer | undefined => {
    if (Api.InputPeerSelf.is(peer)) return context.self();
    if (Api.InputPeerUser.is(peer))
      return { id: `u:${peer.userId}`, kind: 'user', accessHash: String(peer.accessHash) };
    if (Api.InputPeerChat.is(peer)) return { id: `g:${peer.chatId}`, kind: 'group' };
    if (Api.InputPeerChannel.is(peer))
      return { id: `c:${peer.channelId}`, kind: 'channel', accessHash: String(peer.accessHash) };
    return undefined;
  };
  const peers = (values: readonly Tl.TypeInputPeer[]) =>
    values.flatMap((value) => {
      const peer = inputPeer(value);
      return peer ? [peer] : [];
    });
  const mapFolder = (raw: Tl.TypeDialogFilter): TelegramChatFolder | undefined => {
    if (!Api.DialogFilter.is(raw) && !Api.DialogFilterChatlist.is(raw)) return undefined;
    return {
      id: raw.id,
      title: raw.title.text,
      emoticon: raw.emoticon,
      color: raw.color,
      shared: Api.DialogFilterChatlist.is(raw),
      pinned: peers(raw.pinnedPeers),
      included: peers(raw.includePeers),
      excluded: Api.DialogFilter.is(raw) ? peers(raw.excludePeers) : [],
      categories: Api.DialogFilter.is(raw) ? folderCategories.filter((key) => raw[key]) : [],
      exclusions: Api.DialogFilter.is(raw) ? folderExclusions.filter((key) => raw[key]) : [],
    };
  };
  const mapLink = (raw: Tl.ExportedChatlistInvite): TelegramFolderLink => ({
    title: raw.title,
    url: raw.url,
    peers: raw.peers.flatMap((value) => {
      const peer = context.peer(value);
      return peer ? [peer] : [];
    }),
  });
  const getChatFolders = Effect.fn('ChatFolders.get')(function* () {
    const result = yield* (yield* context.client).invoke(Api.messages.GetDialogFilters());
    return result.filters.flatMap((raw) => {
      const folder = mapFolder(raw);
      return folder ? [folder] : [];
    });
  });
  const saveChatFolder = Effect.fn('ChatFolders.save')(function* (folder: TelegramChatFolder) {
    const base = {
      id: folder.id,
      title: Api.TextWithEntities({ text: folder.title, entities: [] }),
      ...(folder.emoticon ? { emoticon: folder.emoticon } : {}),
      ...(folder.color !== undefined ? { color: folder.color } : {}),
      pinnedPeers: folder.pinned.map((peer) => context.toInputPeer(peer)),
      includePeers: folder.included.map((peer) => context.toInputPeer(peer)),
    };
    const flags = Object.fromEntries(
      [...folder.categories, ...folder.exclusions].map((key) => [key, true as const]),
    );
    const filter = folder.shared
      ? Api.DialogFilterChatlist(base)
      : Api.DialogFilter({
          ...base,
          ...flags,
          excludePeers: folder.excluded.map((peer) => context.toInputPeer(peer)),
        });
    yield* (yield* context.client).invoke(
      Api.messages.UpdateDialogFilter({ id: folder.id, filter }),
    );
  });
  const deleteChatFolder = Effect.fn('ChatFolders.delete')(function* (id: number) {
    yield* (yield* context.client).invoke(Api.messages.UpdateDialogFilter({ id }));
  });
  const reorderChatFolders = Effect.fn('ChatFolders.order')(function* (ids: number[]) {
    yield* (yield* context.client).invoke(
      Api.messages.UpdateDialogFiltersOrder({ order: [0, ...ids] }),
    );
  });
  const getFolderLinks = Effect.fn('ChatFolders.links')(function* (id: number) {
    const result = yield* (yield* context.client).invoke(
      Api.chatlists.GetExportedInvites({
        chatlist: Api.InputChatlistDialogFilter({ filterId: id }),
      }),
    );
    context.remember(result.users, result.chats);
    return result.invites.map(mapLink);
  });
  const exportFolderLink = Effect.fn('ChatFolders.export')(function* (
    id: number,
    title: string,
    selected: TelegramPeer[],
  ) {
    const result = yield* (yield* context.client).invoke(
      Api.chatlists.ExportChatlistInvite({
        chatlist: Api.InputChatlistDialogFilter({ filterId: id }),
        title,
        peers: selected.map((peer) => context.toInputPeer(peer)),
      }),
    );
    return mapLink(result.invite);
  });
  const deleteFolderLink = Effect.fn('ChatFolders.revoke')(function* (id: number, slug: string) {
    yield* (yield* context.client).invoke(
      Api.chatlists.DeleteExportedInvite({
        chatlist: Api.InputChatlistDialogFilter({ filterId: id }),
        slug,
      }),
    );
  });
  const checkFolderInvite = Effect.fn('ChatFolders.checkInvite')(function* (
    slug: string,
  ): Effect.fn.Return<TelegramFolderInvite, MtprotoError> {
    const result = yield* (yield* context.client).invoke(
      Api.chatlists.CheckChatlistInvite({ slug }),
    );
    context.remember(result.users, result.chats);
    const already = Api.chatlists.ChatlistInviteAlready.is(result);
    return {
      slug,
      title: already ? 'Add chats to folder' : result.title.text,
      folderId: already ? result.filterId : undefined,
      peers: (already ? [...result.missingPeers, ...result.alreadyPeers] : result.peers).flatMap(
        (value) => {
          const person = context.person(value);
          return person ? [person] : [];
        },
      ),
      already: already
        ? result.alreadyPeers.flatMap((value) => {
            const peer = context.peer(value);
            return peer ? [peer.id] : [];
          })
        : [],
    };
  });
  const joinFolderInvite = Effect.fn('ChatFolders.join')(function* (
    slug: string,
    selected: TelegramPeer[],
  ) {
    return yield* (yield* context.client).invoke(
      Api.chatlists.JoinChatlistInvite({
        slug,
        peers: selected.map((peer) => context.toInputPeer(peer)),
      }),
    );
  });
  const updateCache = new WeakMap<
    MtprotoClient,
    Map<number, { expires: number; invite: TelegramFolderInvite }>
  >();
  const getFolderUpdates = Effect.fn('ChatFolders.updates')(function* (
    id: number,
  ): Effect.fn.Return<TelegramFolderInvite, MtprotoError> {
    const client = yield* context.client;
    let cache = updateCache.get(client);
    if (!cache) {
      cache = new Map();
      updateCache.set(client, cache);
    }
    const cached = cache.get(id);
    if (cached && cached.expires > Date.now()) return structuredClone(cached.invite);
    const config = yield* client
      .invoke(Api.help.GetAppConfig({ hash: 0 }))
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    const interval =
      config && Api.help.AppConfig.is(config) && Api.JsonObject.is(config.config)
        ? config.config.value.find((entry) => entry.key === 'chatlist_update_period')?.value
        : undefined;
    const period =
      interval && Api.JsonNumber.is(interval) && interval.value > 0 ? interval.value : 3600;
    const result = yield* client.invoke(
      Api.chatlists.GetChatlistUpdates({
        chatlist: Api.InputChatlistDialogFilter({ filterId: id }),
      }),
    );
    context.remember(result.users, result.chats);
    const invite: TelegramFolderInvite = {
      slug: '',
      folderId: id,
      title: 'New chats in folder',
      already: [],
      peers: result.missingPeers.flatMap((peer) => {
        const person = context.person(peer);
        return person ? [person] : [];
      }),
    };
    cache.set(id, { expires: Date.now() + period * 1000, invite });
    return structuredClone(invite);
  });
  const joinFolderUpdates = Effect.fn('ChatFolders.joinUpdates')(function* (
    id: number,
    selected: TelegramPeer[],
  ) {
    const client = yield* context.client;
    const result = yield* client.invoke(
      Api.chatlists.JoinChatlistUpdates({
        chatlist: Api.InputChatlistDialogFilter({ filterId: id }),
        peers: selected.map((peer) => context.toInputPeer(peer)),
      }),
    );
    const cached = updateCache.get(client)?.get(id);
    if (cached)
      cached.invite = {
        ...cached.invite,
        peers: cached.invite.peers.filter(
          (person) => !selected.some((peer) => peer.id === person.peer.id),
        ),
      };
    return result;
  });
  return {
    getFolderUpdates,
    joinFolderUpdates,
    getChatFolders,
    saveChatFolder,
    deleteChatFolder,
    reorderChatFolders,
    getFolderLinks,
    exportFolderLink,
    deleteFolderLink,
    checkFolderInvite,
    joinFolderInvite,
  };
}
