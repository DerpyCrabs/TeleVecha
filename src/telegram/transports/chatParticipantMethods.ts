import { Effect } from 'effect';
import type { MtprotoClient } from '../mtproto';
import { createMtprotoError, type MtprotoError } from '../mtproto/errors';
import { Api, type Tl } from '../mtproto/tl';
import {
  adminRightKeys,
  restrictionKeys,
  type ChatParticipantFilter,
  type ChatParticipantChange,
  type ManagedParticipant,
  type ManagedParticipantsPage,
} from '../chatManagement';
import type { TelegramPeer, TelegramPeerSearchResult } from '../types';
export function chatParticipantMethods(context: {
  client: Effect.Effect<MtprotoClient, MtprotoError>;
  inputPeer(peer: TelegramPeer): Tl.TypeInputPeer;
  inputChannel(peer: TelegramPeer): Tl.TypeInputChannel;
  inputUser(peer: TelegramPeer): Tl.TypeInputUser;
  remember(users: readonly Tl.TypeUser[], chats: readonly Tl.TypeChat[]): void;
  person(id: string): TelegramPeerSearchResult;
}) {
  const getManagedParticipants = Effect.fn('ChatParticipants.list')(function* (
    peer: TelegramPeer,
    filter: ChatParticipantFilter = 'members',
    query: string = '',
    offset: number = 0,
  ): Effect.fn.Return<ManagedParticipantsPage, MtprotoError> {
    if (peer.kind === 'user')
      return yield* Effect.fail(createMtprotoError('configuration', 'Choose a group or channel.'));
    const client = yield* context.client;
    if (peer.kind === 'group') {
      const result = yield* client.invoke(
        Api.messages.GetFullChat({ chatId: BigInt(peer.id.slice(2)) }),
      );
      context.remember(result.users, result.chats);
      const chat = result.chats.find(
        (chat) => Api.Chat.is(chat) && chat.id === BigInt(peer.id.slice(2)),
      );
      const owner = Api.Chat.is(chat) && Boolean(chat.creator);
      const participants =
        Api.ChatFull.is(result.fullChat) && Api.ChatParticipants.is(result.fullChat.participants)
          ? result.fullChat.participants.participants
          : [];
      const all = participants
        .map((participant): ManagedParticipant => {
          const id = `u:${participant.userId}`;
          const person = context.person(id);
          const self = result.users.some(
            (user) => user.id === participant.userId && Api.User.is(user) && user.self,
          );
          const role = Api.ChatParticipantCreator.is(participant)
            ? 'owner'
            : Api.ChatParticipantAdmin.is(participant)
              ? 'admin'
              : 'member';
          return {
            ...person,
            role,
            self,
            editable: !self && role !== 'owner' && (role !== 'admin' || owner),
            rank: 'rank' in participant ? (participant.rank ?? '') : '',
            adminRights: {},
            restrictions: {},
            untilDate: 0,
          };
        })
        .filter(
          (person) =>
            (filter === 'members' ||
              (filter === 'admins' && (person.role === 'admin' || person.role === 'owner'))) &&
            (!query.trim() || person.title.toLowerCase().includes(query.trim().toLowerCase())),
        );
      return {
        people: all.slice(offset, offset + 50),
        count: all.length,
        nextOffset: offset + 50 < all.length ? offset + 50 : undefined,
      };
    }
    const result = yield* client.invoke(
      Api.channels.GetParticipants({
        channel: context.inputChannel(peer),
        filter:
          filter === 'admins'
            ? Api.ChannelParticipantsAdmins({})
            : filter === 'restricted'
              ? Api.ChannelParticipantsBanned({ q: query.trim() })
              : filter === 'removed'
                ? Api.ChannelParticipantsKicked({ q: query.trim() })
                : query.trim()
                  ? Api.ChannelParticipantsSearch({ q: query.trim() })
                  : Api.ChannelParticipantsRecent({}),
        offset,
        limit: 50,
        hash: 0n,
      }),
    );
    if (!Api.channels.ChannelParticipants.is(result)) return { people: [], count: 0 };
    context.remember(result.users, result.chats);
    const people = result.participants
      .flatMap((participant): ManagedParticipant[] => {
        const id =
          'userId' in participant
            ? `u:${participant.userId}`
            : Api.ChannelParticipantBanned.is(participant) && Api.PeerUser.is(participant.peer)
              ? `u:${participant.peer.userId}`
              : Api.ChannelParticipantBanned.is(participant) && Api.PeerChannel.is(participant.peer)
                ? `c:${participant.peer.channelId}`
                : undefined;
        if (!id) return [];
        const person = context.person(id);
        const self =
          Api.ChannelParticipantSelf.is(participant) ||
          (Api.ChannelParticipantAdmin.is(participant) && Boolean(participant.self)) ||
          result.users.some((user) => `u:${user.id}` === id && Api.User.is(user) && user.self);
        const admin = Api.ChannelParticipantAdmin.is(participant);
        const owner = Api.ChannelParticipantCreator.is(participant);
        const banned = Api.ChannelParticipantBanned.is(participant)
          ? participant.bannedRights
          : undefined;
        const rights = admin || owner ? participant.adminRights : undefined;
        return [
          {
            ...person,
            self,
            role: owner
              ? 'owner'
              : admin
                ? 'admin'
                : banned
                  ? banned.viewMessages
                    ? 'removed'
                    : 'restricted'
                  : 'member',
            editable: !self && !owner && (!admin || Boolean(participant.canEdit)),
            rank: 'rank' in participant ? (participant.rank ?? '') : '',
            adminRights: Object.fromEntries(
              adminRightKeys.map((key) => [key, Boolean(rights?.[key])]),
            ),
            restrictions: Object.fromEntries(
              restrictionKeys.map((key) => [key, Boolean(banned?.[key])]),
            ),
            untilDate: banned?.untilDate ?? 0,
          },
        ];
      })
      .filter(
        (person) =>
          filter !== 'admins' ||
          !query.trim() ||
          person.title.toLowerCase().includes(query.trim().toLowerCase()),
      );
    return {
      people,
      count: result.count,
      nextOffset:
        result.participants.length === 50 && offset + result.participants.length < result.count
          ? offset + result.participants.length
          : undefined,
    };
  });
  const addChatMember = Effect.fn('ChatParticipants.add')(function* (
    peer: TelegramPeer,
    user: TelegramPeer,
  ) {
    const client = yield* context.client;
    if (peer.kind === 'user' || user.kind !== 'user')
      return yield* Effect.fail(createMtprotoError('configuration', 'Choose a person to add.'));
    const result =
      peer.kind === 'channel'
        ? yield* client.invoke(
            Api.channels.InviteToChannel({
              channel: context.inputChannel(peer),
              users: [context.inputUser(user)],
            }),
          )
        : yield* client.invoke(
            Api.messages.AddChatUser({
              chatId: BigInt(peer.id.slice(2)),
              userId: context.inputUser(user),
              fwdLimit: 0,
            }),
          );
    return {
      updates: result.updates,
      missingUserIds: result.missingInvitees.map((user) => `u:${user.userId}`),
    };
  });
  const editChatParticipant = Effect.fn('ChatParticipants.edit')(function* (
    peer: TelegramPeer,
    user: TelegramPeer,
    change: ChatParticipantChange,
  ) {
    const client = yield* context.client;
    if (peer.kind === 'user')
      return yield* Effect.fail(createMtprotoError('configuration', 'Choose a group or channel.'));
    if (peer.kind === 'group') {
      if (change.kind === 'remove')
        return yield* client.invoke(
          Api.messages.DeleteChatUser({
            chatId: BigInt(peer.id.slice(2)),
            userId: context.inputUser(user),
          }),
        );
      if (change.kind !== 'admin')
        return yield* Effect.fail(
          createMtprotoError('configuration', 'Personal restrictions require a supergroup.'),
        );
      const success = yield* client.invoke(
        Api.messages.EditChatAdmin({
          chatId: BigInt(peer.id.slice(2)),
          userId: context.inputUser(user),
          isAdmin: Object.values(change.rights).some(Boolean),
        }),
      );
      if (!success)
        return yield* Effect.fail(
          createMtprotoError('rpc', 'Administrator rights could not be changed.'),
        );
      return undefined;
    }
    const channel = context.inputChannel(peer);
    if (change.kind === 'admin')
      return yield* client.invoke(
        Api.channels.EditAdmin({
          channel,
          userId: context.inputUser(user),
          adminRights: Api.ChatAdminRights(
            Object.fromEntries(
              adminRightKeys.filter((key) => change.rights[key]).map((key) => [key, true as const]),
            ),
          ),
          rank: change.rank,
        }),
      );
    const restrictions =
      change.kind === 'remove'
        ? { viewMessages: true as const }
        : change.kind === 'restrict'
          ? Object.fromEntries(
              restrictionKeys
                .filter((key) => change.restrictions[key])
                .map((key) => [key, true as const]),
            )
          : {};
    return yield* client.invoke(
      Api.channels.EditBanned({
        channel,
        participant: context.inputPeer(user),
        bannedRights: Api.ChatBannedRights({
          ...restrictions,
          untilDate: change.kind === 'restrict' ? change.untilDate : 0,
        }),
      }),
    );
  });
  return { getManagedParticipants, addChatMember, editChatParticipant };
}
