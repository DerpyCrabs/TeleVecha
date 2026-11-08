import { Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import { Api, createTl } from '../mtproto/tl';
import type { MtprotoClient } from '../mtproto';
import { chatInviteMethods } from './chatInviteMethods';
const peer = { id: 'c:202', kind: 'channel' as const, accessHash: '5' };
function api(invoke: (request: unknown) => Effect.Effect<unknown>) {
  return chatInviteMethods({
    client: Effect.succeed({ invoke } as unknown as MtprotoClient),
    inputPeer: () => Api.InputPeerChannel({ channelId: 202n, accessHash: 5n }),
    remember: () => {},
  });
}
const link = (id: number) =>
  createTl('chatInviteExported', {
    link: `https://t.me/+invite${id}`,
    adminId: 1n,
    date: id,
    usage: 3,
    usageLimit: 10,
    requested: 1,
    title: 'Project',
  });
it('preserves revoked filtering and the server date/link cursor', async () => {
  const invoke = vi.fn((request: unknown) => {
    expect(request).toMatchObject({
      revoked: true,
      offsetDate: 10,
      offsetLink: 'previous',
      adminId: { _: 'inputUserSelf' },
      limit: 50,
    });
    return Effect.succeed(
      createTl('messages.exportedChatInvites', {
        count: 51,
        invites: Array.from({ length: 50 }, (_, index) => link(index + 1)),
        users: [],
      }),
    );
  });
  const result = await Effect.runPromise(
    api(invoke).getChatInviteLinks(peer, true, { date: 10, url: 'previous' }),
  );
  expect(result.nextOffset).toEqual({ date: 50, url: 'https://t.me/+invite50' });
  expect(result.links[0]).toMatchObject({
    usage: 3,
    usageLimit: 10,
    requested: 1,
    title: 'Project',
  });
});
it('omits usage limits for approval-based links and does not revoke the primary link when creating', async () => {
  const invoke = vi.fn((_request: unknown) => Effect.succeed(link(1)));
  await Effect.runPromise(
    api(invoke).exportChatInviteLink(peer, {
      title: 'Project',
      requestNeeded: true,
      expireDate: 0,
      usageLimit: 10,
    }),
  );
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({ requestNeeded: true });
  expect(invoke.mock.calls[0]?.[0]).not.toHaveProperty('usageLimit');
  expect(invoke.mock.calls[0]?.[0]).not.toHaveProperty('legacyRevokePermanent');
});
it('sends explicit false and zero when clearing approval and limits', async () => {
  const invoke = vi.fn((_request: unknown) =>
    Effect.succeed(createTl('messages.exportedChatInvite', { invite: link(1), users: [] })),
  );
  await Effect.runPromise(
    api(invoke).editChatInviteLink(peer, 'https://t.me/+invite1', {
      title: '',
      requestNeeded: false,
      expireDate: 0,
      usageLimit: 0,
    }),
  );
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({
    title: '',
    requestNeeded: false,
    expireDate: 0,
    usageLimit: 0,
  });
});
it('revokes a link separately from permanently deleting its revoked record', async () => {
  const invoke = vi.fn((request: unknown) =>
    Api.messages.EditExportedChatInvite.is(request)
      ? Effect.succeed(
          createTl('messages.exportedChatInviteReplaced', {
            invite: link(1),
            newInvite: link(2),
            users: [],
          }),
        )
      : Effect.succeed(true),
  );
  await Effect.runPromise(api(invoke).revokeChatInviteLink(peer, 'https://t.me/+invite1'));
  await Effect.runPromise(api(invoke).deleteChatInviteLink(peer, 'https://t.me/+invite1'));
  expect(invoke.mock.calls[0]?.[0]).toMatchObject({ revoked: true, link: 'https://t.me/+invite1' });
  expect(Api.messages.DeleteExportedChatInvite.is(invoke.mock.calls[1]?.[0])).toBe(true);
});
