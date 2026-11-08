import { Effect } from 'effect';
import { it, expect, vi } from 'vitest';
import { Api, createTl } from '../mtproto/tl';
import type { MtprotoClient } from '../mtproto';
import { chatManagementMethods } from './chatManagementMethods';
const peer = { id: 'c:202', kind: 'channel' as const, accessHash: '5' };
function api(invoke: (request: unknown) => Effect.Effect<unknown>) {
  return chatManagementMethods({
    client: Effect.succeed({ invoke } as unknown as MtprotoClient),
    inputPeer: () => Api.InputPeerChannel({ channelId: 202n, accessHash: 5n }),
    inputChannel: () => Api.InputChannel({ channelId: 202n, accessHash: 5n }),
    remember: () => {},
  });
}
const updates = () => Api.Updates({ updates: [], users: [], chats: [], date: 1, seq: 1 });
it('uses different title methods for basic groups and channels', async () => {
  const invoke = vi.fn((_request: unknown) => Effect.succeed(updates()));
  const methods = api(invoke);
  await Effect.runPromise(methods.setChatSetting(peer, { kind: 'title', value: 'Team' }));
  await Effect.runPromise(
    methods.setChatSetting({ id: 'g:303', kind: 'group' }, { kind: 'title', value: 'Plans' }),
  );
  expect(Api.channels.EditTitle.is(invoke.mock.calls[0]?.[0])).toBe(true);
  expect(invoke.mock.calls[1]?.[0]).toMatchObject({
    _: 'messages.editChatTitle',
    chatId: 303n,
    title: 'Plans',
  });
});
it('preserves disabled and zero settings instead of dropping their values', async () => {
  const invoke = vi.fn((_request: unknown) => Effect.succeed(updates()));
  const methods = api(invoke);
  await Effect.runPromise(methods.setChatSetting(peer, { kind: 'forum', value: false }));
  await Effect.runPromise(methods.setChatSetting(peer, { kind: 'slowModeSeconds', value: 0 }));
  await Effect.runPromise(methods.setChatSetting(peer, { kind: 'hiddenHistory', value: false }));
  await Effect.runPromise(methods.setChatSetting(peer, { kind: 'protectedContent', value: false }));
  expect(invoke.mock.calls.map(([request]) => request)).toMatchObject([
    { enabled: false, tabs: false },
    { seconds: 0 },
    { enabled: false },
    { enabled: false },
  ]);
});
it('does not infer ownership from a limited administrator role', async () => {
  const invoke = () =>
    Effect.succeed(
      createTl('messages.chatFull', {
        fullChat: createTl('channelFull', {
          id: 202n,
          about: 'Project',
          slowmodeSeconds: 30,
          hiddenPrehistory: true,
        }),
        chats: [
          createTl('channel', {
            id: 202n,
            title: 'Team',
            accessHash: 5n,
            megagroup: true,
            photo: Api.ChatPhotoEmpty({}),
            date: 1,
            adminRights: createTl('chatAdminRights', { changeInfo: true, inviteUsers: true }),
          }),
        ],
        users: [],
      }),
    );
  const settings = await Effect.runPromise(api(invoke).getChatManagement(peer));
  expect(settings).toMatchObject({
    title: 'Team',
    about: 'Project',
    slowModeSeconds: 30,
    hiddenHistory: true,
    rights: {
      changeInfo: true,
      manageInvites: true,
      changeType: false,
      manageAdmins: false,
      restrictMembers: false,
      manageTopics: false,
      viewLog: true,
    },
  });
});
it('rejects a false boolean save result', async () => {
  await expect(
    Effect.runPromise(
      api(() => Effect.succeed(false)).setChatSetting(peer, {
        kind: 'username',
        value: 'team_chat',
      }),
    ),
  ).rejects.toThrow('public link could not be changed');
});

it('sends default restrictions without removing members or retaining false flags', async () => {
  const invoke = vi.fn((_request: unknown) => Effect.succeed(updates()));
  await Effect.runPromise(
    api(invoke).setChatSetting(peer, {
      kind: 'defaultRestrictions',
      value: { sendPhotos: true, sendPolls: false, viewMessages: true },
    }),
  );
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({
    _: 'messages.editChatDefaultBannedRights',
    bannedRights: { _: 'chatBannedRights', sendPhotos: true, untilDate: 0 },
  });
  const request = invoke.mock.calls[0]?.[0];
  if (!Api.messages.EditChatDefaultBannedRights.is(request)) throw new Error('wrong request');
  expect(request.bannedRights.sendPolls).toBeUndefined();
  expect(request.bannedRights.viewMessages).toBeUndefined();
});
it('reuses an existing migration instead of issuing another conversion', async () => {
  const invoke = vi.fn((_request: unknown) =>
    Effect.succeed(
      createTl('messages.chatFull', {
        fullChat: createTl('chatFull', { id: 303n, about: '' }),
        chats: [
          createTl('chat', {
            id: 303n,
            title: 'Team',
            photo: Api.ChatPhotoEmpty({}),
            participantsCount: 2,
            date: 1,
            version: 1,
            migratedTo: Api.InputChannel({ channelId: 707n, accessHash: 9n }),
          }),
        ],
        users: [],
      }),
    ),
  );
  const result = await Effect.runPromise(api(invoke).upgradeChat({ id: 'g:303', kind: 'group' }));
  expect(result.peer).toEqual({ id: 'c:707', kind: 'channel', accessHash: '9' });
  expect(invoke).toHaveBeenCalledOnce();
  expect(result.updates).toBeUndefined();
});
it('resolves the new address after migrating a basic group', async () => {
  const full = (migrated: boolean) =>
    createTl('messages.chatFull', {
      fullChat: createTl('chatFull', { id: 303n, about: '' }),
      chats: [
        createTl('chat', {
          id: 303n,
          title: 'Team',
          photo: Api.ChatPhotoEmpty({}),
          participantsCount: 2,
          date: 1,
          version: 1,
          ...(migrated
            ? { migratedTo: Api.InputChannel({ channelId: 707n, accessHash: 9n }) }
            : {}),
        }),
      ],
      users: [],
    });
  let converted = false;
  const invoke = vi.fn((request: unknown) => {
    if (Api.messages.MigrateChat.is(request)) {
      converted = true;
      return Effect.succeed(updates());
    }
    return Effect.succeed(full(converted));
  });
  const result = await Effect.runPromise(api(invoke).upgradeChat({ id: 'g:303', kind: 'group' }));
  expect(result.peer.id).toBe('c:707');
  expect(result.title).toBe('Team');
  expect(invoke.mock.calls[1]?.[0]).toMatchObject({ _: 'messages.migrateChat', chatId: 303n });
  expect(result.updates).toBeDefined();
});

it('exposes both directions of group migration for history navigation', async () => {
  const old = createTl('chat', {
    id: 303n,
    title: 'Team',
    photo: Api.ChatPhotoEmpty({}),
    participantsCount: 2,
    date: 1,
    version: 1,
    migratedTo: Api.InputChannel({ channelId: 202n, accessHash: 5n }),
  });
  const channel = createTl('channel', {
    id: 202n,
    title: 'Team',
    photo: Api.ChatPhotoEmpty({}),
    date: 1,
    megagroup: true,
  });
  const methods = api((request) =>
    Effect.succeed(
      createTl('messages.chatFull', {
        users: [],
        chats: [old, channel],
        fullChat: Api.messages.GetFullChat.is(request)
          ? createTl('chatFull', {
              id: 303n,
              about: '',
              participants: createTl('chatParticipants', {
                chatId: 303n,
                participants: [],
                version: 1,
              }),
              notifySettings: Api.PeerNotifySettings({}),
            })
          : createTl('channelFull', {
              id: 202n,
              about: '',
              migratedFromChatId: 303n,
              migratedFromMaxId: 50,
            }),
      }),
    ),
  );
  expect((await Effect.runPromise(methods.getChatManagement(peer))).migratedFrom).toEqual({
    id: 'g:303',
    kind: 'group',
  });
  expect(
    (await Effect.runPromise(methods.getChatManagement({ id: 'g:303', kind: 'group' }))).migratedTo,
  ).toEqual(peer);
});
