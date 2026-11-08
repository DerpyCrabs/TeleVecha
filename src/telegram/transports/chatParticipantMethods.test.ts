import { Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import type { MtprotoClient } from '../mtproto';
import { Api, createTl } from '../mtproto/tl';
import { chatParticipantMethods } from './chatParticipantMethods';
const peer = { id: 'c:202', kind: 'channel' as const, accessHash: '5' };
const user = { id: 'u:101', kind: 'user' as const, accessHash: '7' };
function methods(invoke: (request: unknown) => Effect.Effect<unknown>) {
  return chatParticipantMethods({
    client: Effect.succeed({ invoke } as unknown as MtprotoClient),
    inputPeer: (peer) =>
      peer.kind === 'user'
        ? Api.InputPeerUser({ userId: BigInt(peer.id.slice(2)), accessHash: 7n })
        : Api.InputPeerChannel({ channelId: 202n, accessHash: 5n }),
    inputChannel: () => Api.InputChannel({ channelId: 202n, accessHash: 5n }),
    inputUser: () => Api.InputUser({ userId: 101n, accessHash: 7n }),
    remember: () => {},
    person: (id) => ({
      peer: { ...user, id },
      title: id,
      initials: 'U',
      color: '#5288c1',
      hasAvatar: false,
      category: 'user',
      bot: false,
      isContact: false,
    }),
  });
}
const updates = () => Api.Updates({ updates: [], users: [], chats: [], date: 1, seq: 1 });
it('uses an empty rights object to demote a channel administrator', async () => {
  const invoke = vi.fn((_request: unknown) => Effect.succeed(updates()));
  await Effect.runPromise(
    methods(invoke).editChatParticipant(peer, user, {
      kind: 'admin',
      rights: { inviteUsers: false, addAdmins: false },
      rank: '',
    }),
  );
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({
    _: 'channels.editAdmin',
    rank: '',
    adminRights: { _: 'chatAdminRights' },
  });
  expect(invoke.mock.calls[0]?.[0]).not.toHaveProperty('adminRights.inviteUsers');
});
it('distinguishes removing, restoring access, and personal sending restrictions', async () => {
  const invoke = vi.fn((_request: unknown) => Effect.succeed(updates()));
  const api = methods(invoke);
  await Effect.runPromise(api.editChatParticipant(peer, user, { kind: 'remove' }));
  await Effect.runPromise(api.editChatParticipant(peer, user, { kind: 'unban' }));
  await Effect.runPromise(
    api.editChatParticipant(peer, user, {
      kind: 'restrict',
      restrictions: { sendPhotos: true, sendPlain: false },
      untilDate: 1800000000,
    }),
  );
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({
    bannedRights: { viewMessages: true, untilDate: 0 },
  });
  expect(invoke.mock.calls[1]?.[0]).toMatchObject({ bannedRights: { untilDate: 0 } });
  expect(invoke.mock.calls[1]?.[0]).not.toHaveProperty('bannedRights.viewMessages');
  expect(invoke.mock.calls[2]?.[0]).toMatchObject({
    bannedRights: { sendPhotos: true, untilDate: 1800000000 },
  });
  expect(invoke.mock.calls[2]?.[0]).not.toHaveProperty('bannedRights.sendPlain');
});
it('does not erase existing history when removing a member from a basic group', async () => {
  const invoke = vi.fn((_request: unknown) => Effect.succeed(updates()));
  await Effect.runPromise(
    methods(invoke).editChatParticipant({ id: 'g:303', kind: 'group' }, user, { kind: 'remove' }),
  );
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({ _: 'messages.deleteChatUser', chatId: 303n });
  expect(invoke.mock.calls[0]?.[0]).not.toHaveProperty('revokeHistory');
});
it('returns users Telegram could not invite rather than claiming they joined', async () => {
  const invoke = vi.fn((_request: unknown) =>
    Effect.succeed(
      createTl('messages.invitedUsers', {
        updates: updates(),
        missingInvitees: [createTl('missingInvitee', { userId: 101n })],
      }),
    ),
  );
  expect(await Effect.runPromise(methods(invoke).addChatMember(peer, user))).toMatchObject({
    missingUserIds: ['u:101'],
  });
});
it('honors the server can_edit flag for administrators and never edits the owner', async () => {
  const invoke = () =>
    Effect.succeed(
      createTl('channels.channelParticipants', {
        count: 3,
        participants: [
          createTl('channelParticipantCreator', {
            userId: 1n,
            adminRights: Api.ChatAdminRights({}),
          }),
          createTl('channelParticipantAdmin', {
            userId: 2n,
            promotedBy: 1n,
            date: 1,
            adminRights: Api.ChatAdminRights({ inviteUsers: true }),
          }),
          createTl('channelParticipantAdmin', {
            userId: 3n,
            promotedBy: 1n,
            date: 1,
            canEdit: true,
            adminRights: Api.ChatAdminRights({ inviteUsers: true }),
          }),
        ],
        users: [],
        chats: [],
      }),
    );
  const result = await Effect.runPromise(methods(invoke).getManagedParticipants(peer, 'admins'));
  expect(result.people.map(({ editable }) => editable)).toEqual([false, false, true]);
});
