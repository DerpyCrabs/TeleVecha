import { Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import { makeQueryCache } from 'effectweb';
import { permissionsForDialog } from '../../telegram/core/chatPermissions';
import type { TelegramDialog, TelegramGroupMemberPage } from '../../telegram/types';
import { createContactDetailsSession } from './contactDetailsSession';

it('clears member pages synchronously on cache reset and cancels their pending continuation', async () => {
  const dialog: TelegramDialog = {
    peer: { kind: 'group', id: 'group' },
    title: 'Group',
    initials: 'G',
    color: '#000',
    topMessageId: 0,
    unreadCount: 0,
    readInboxMaxId: 0,
    readOutboxMaxId: 0,
    muted: false,
    pinned: false,
    hasAvatar: false,
  };
  dialog.permissions = { ...permissionsForDialog(dialog), canViewMembers: true };
  const member = {
    peer: { kind: 'user' as const, id: 'old' },
    title: 'Old member',
    initials: 'O',
    color: '#000',
    hasAvatar: false,
  };
  const cancelled = vi.fn();
  let finish!: () => void;
  const cache = makeQueryCache();
  const session = createContactDetailsSession(
    {
      source: {
        getGroupMembers: (_peer, _limit, offset) =>
          offset === undefined
            ? Effect.succeed({ members: [member], totalCount: 2, hasMore: true, nextOffset: 1 })
            : Effect.callback<TelegramGroupMemberPage>((resume) => {
                finish = () =>
                  resume(Effect.succeed({ members: [member], totalCount: 2, hasMore: false }));
                return Effect.sync(cancelled);
              }),
        updateContact: () => Effect.void,
        deleteContact: () => Effect.void,
        subscribeResources: () => Effect.succeed(Effect.void),
      },
      runEffect: Effect.runPromise,
      runTask: Effect.runFork,
      dialog: () => dialog,
      detailsOpen: () => true,
    },
    { cache, changed() {} },
  );
  session.refresh();
  await vi.waitFor(() => expect(session.snapshot().members).toEqual([member]));
  session.loadMoreMembers();
  await vi.waitFor(() => expect(session.snapshot().membersLoadingMore).toBe(true));
  cache.resetResources();
  expect(session.snapshot().members).toEqual([]);
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(session.snapshot().members).toEqual([]);
  session.dispose();
  cache.dispose();
});
