import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { chatFolderMethods } from './chatFolderMethods';
import { Api, createTl } from '../mtproto/tl';
import type { MtprotoClient } from '../mtproto';
import type { TelegramChatFolder } from '../chatFolders';
const group = { id: 'g:303', kind: 'group' as const };
const folder: TelegramChatFolder = {
  id: 2,
  title: 'Work',
  shared: false,
  categories: ['groups'],
  exclusions: ['excludeRead'],
  included: [group],
  excluded: [],
  pinned: [],
};
function methods(invoke: (request: unknown) => Effect.Effect<unknown>) {
  return chatFolderMethods({
    client: Effect.succeed({ invoke } as unknown as MtprotoClient),
    self: () => undefined,
    toInputPeer: () => Api.InputPeerChat({ chatId: 303n }),
    peer: () => group,
    person: () => undefined,
    remember: () => {},
  });
}
describe('chat folder RPCs', () => {
  it('retains filtering rules and explicit chats when reading a folder', async () => {
    const api = methods((request) => {
      expect(Api.messages.GetDialogFilters.is(request)).toBe(true);
      return Effect.succeed(
        createTl('messages.dialogFilters', {
          filters: [
            Api.DialogFilter({
              id: 2,
              title: Api.TextWithEntities({ text: 'Work', entities: [] }),
              groups: true,
              excludeRead: true,
              pinnedPeers: [],
              includePeers: [Api.InputPeerChat({ chatId: 303n })],
              excludePeers: [],
            }),
          ],
        }),
      );
    });
    expect(await Effect.runPromise(api.getChatFolders())).toEqual([
      expect.objectContaining(folder),
    ]);
  });
  it('writes rules as Telegram flags and deletes by omitting the filter', async () => {
    const invoke = vi.fn((request: unknown) => {
      expect(Api.messages.UpdateDialogFilter.is(request)).toBe(true);
      return Effect.succeed(true);
    });
    const api = methods(invoke);
    await Effect.runPromise(api.saveChatFolder(folder));
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      id: 2,
      filter: { groups: true, excludeRead: true, includePeers: [{ chatId: 303n }] },
    });
    await Effect.runPromise(api.deleteChatFolder(2));
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ id: 2 });
    expect(invoke.mock.calls[1]?.[0]).not.toHaveProperty('filter');
  });
  it('shares only selected peers and returns the server invite', async () => {
    const api = methods((request) => {
      expect(request).toMatchObject({
        chatlist: { filterId: 2 },
        peers: [{ chatId: 303n }],
        title: 'Team',
      });
      return Effect.succeed(
        createTl('chatlists.exportedChatlistInvite', {
          filter: Api.DialogFilterChatlist({
            id: 2,
            title: Api.TextWithEntities({ text: 'Work', entities: [] }),
            pinnedPeers: [],
            includePeers: [],
          }),
          invite: createTl('exportedChatlistInvite', {
            title: 'Team',
            url: 'https://t.me/addlist/team',
            peers: [Api.PeerChat({ chatId: 303n })],
          }),
        }),
      );
    });
    expect(await Effect.runPromise(api.exportFolderLink(2, 'Team', [group]))).toEqual({
      title: 'Team',
      url: 'https://t.me/addlist/team',
      peers: [group],
    });
  });
});

it('loads shared-folder additions, respects the server update period and joins selected chats', async () => {
  const person = {
    peer: group,
    category: 'group' as const,
    title: 'Group',
    initials: 'G',
    color: '#408acf',
    bot: false,
    isContact: false,
    hasAvatar: false,
  };
  const invoke = vi.fn((request: unknown) => {
    if (Api.help.GetAppConfig.is(request))
      return Effect.succeed(
        createTl('help.appConfig', {
          hash: 1,
          config: Api.JsonObject({
            value: [
              createTl('jsonObjectValue', {
                key: 'chatlist_update_period',
                value: Api.JsonNumber({ value: 3600 }),
              }),
            ],
          }),
        }),
      );
    if (Api.chatlists.GetChatlistUpdates.is(request))
      return Effect.succeed(
        createTl('chatlists.chatlistUpdates', {
          missingPeers: [Api.PeerChat({ chatId: 303n })],
          chats: [],
          users: [],
        }),
      );
    expect(Api.chatlists.JoinChatlistUpdates.is(request)).toBe(true);
    expect(request).toMatchObject({ chatlist: { filterId: 2 }, peers: [{ chatId: 303n }] });
    return Effect.succeed(Api.Updates({ updates: [], users: [], chats: [], date: 0, seq: 0 }));
  });
  const api = chatFolderMethods({
    client: Effect.succeed({ invoke } as unknown as MtprotoClient),
    self: () => undefined,
    toInputPeer: () => Api.InputPeerChat({ chatId: 303n }),
    peer: () => group,
    person: () => person,
    remember: () => {},
  });
  expect((await Effect.runPromise(api.getFolderUpdates(2))).peers).toEqual([person]);
  await Effect.runPromise(api.getFolderUpdates(2));
  expect(invoke).toHaveBeenCalledTimes(2);
  await Effect.runPromise(api.joinFolderUpdates(2, [group]));
  expect((await Effect.runPromise(api.getFolderUpdates(2))).peers).toEqual([]);
  expect(invoke).toHaveBeenCalledTimes(3);
});
