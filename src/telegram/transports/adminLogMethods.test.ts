import { Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import { Api, createTl } from '../mtproto/tl';
import type { MtprotoClient } from '../mtproto';
import { adminLogMethods, mapAdminLogEvent } from './adminLogMethods';
const person = (id: string) => ({
  peer: { id, kind: 'user' as const, accessHash: '7' },
  title: `Person ${id}`,
  initials: 'P',
  color: '#5288c1',
  hasAvatar: false,
});
const event = (id: bigint) =>
  createTl('channelAdminLogEvent', {
    id,
    date: 1700000000,
    userId: 1n,
    action: createTl('channelAdminLogEventActionChangeTitle', {
      prevValue: 'Before',
      newValue: 'After',
    }),
  });
it('keeps 64-bit cursors intact and passes filters and author to Telegram', async () => {
  const invoke = vi.fn((_request: unknown) =>
    Effect.succeed(
      createTl('channels.adminLogResults', {
        events: Array.from({ length: 50 }, (_, i) => event(9007199254742000n - BigInt(i))),
        users: [],
        chats: [],
      }),
    ),
  );
  const remember = vi.fn();
  const api = adminLogMethods({
    client: Effect.succeed({ invoke } as unknown as MtprotoClient),
    inputChannel: () => Api.InputChannel({ channelId: 202n, accessHash: 5n }),
    inputUser: () => Api.InputUser({ userId: 1n, accessHash: 7n }),
    remember,
    person,
  });
  const result = await Effect.runPromise(
    api.getAdminLog(
      { id: 'c:202', kind: 'channel', accessHash: '5' },
      {
        filter: 'messages',
        query: ' text ',
        actor: person('u:1').peer,
        beforeId: '9007199254743000',
      },
    ),
  );
  const request = invoke.mock.calls[0]?.[0];
  if (!Api.channels.GetAdminLog.is(request)) throw new Error('Wrong request');
  expect(request).toMatchObject({ maxId: 9007199254743000n, q: 'text', minId: 0n, limit: 50 });
  expect(request.eventsFilter).toMatchObject({
    delete: true,
    edit: true,
    pinned: true,
    send: true,
  });
  expect(request.admins).toMatchObject([{ userId: 1n }]);
  expect(result.nextId).toBe('9007199254741951');
  expect(remember).toHaveBeenCalledOnce();
  expect(result.events[0]?.details).toEqual([
    { label: 'Previous', text: 'Before' },
    { label: 'New', text: 'After' },
  ]);
});
it('preserves deleted message content and identifies the acting administrator', () => {
  const result = mapAdminLogEvent(
    createTl('channelAdminLogEvent', {
      id: 1n,
      date: 1700000000,
      userId: 9n,
      action: createTl('channelAdminLogEventActionDeleteMessage', {
        message: createTl('message', {
          id: 5,
          peerId: Api.PeerChannel({ channelId: 202n }),
          date: 1700000000,
          message: 'Deleted text',
        }),
      }),
    }),
    person,
  );
  expect(result.actor.peer.id).toBe('u:9');
  expect(result.action).toBe('deleted a message');
  expect(result.details).toContainEqual({ label: 'Message', text: 'Deleted text' });
});
it('shows revoked restrictions instead of calling an unrestricted participant banned', () => {
  const member = createTl('channelParticipant', { userId: 2n, date: 1 });
  const result = mapAdminLogEvent(
    createTl('channelAdminLogEvent', {
      id: 2n,
      date: 1700000000,
      userId: 9n,
      action: createTl('channelAdminLogEventActionParticipantToggleBan', {
        prevParticipant: member,
        newParticipant: member,
      }),
    }),
    person,
  );
  expect(result.details).toContainEqual({ label: 'Member', text: 'Person u:2' });
  expect(result.details).toContainEqual({ label: 'Restrictions', text: 'Removed' });
});
