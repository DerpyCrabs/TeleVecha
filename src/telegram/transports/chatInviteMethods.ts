import { Effect } from 'effect';
import type { MtprotoClient } from '../mtproto';
import { createMtprotoError, type MtprotoError } from '../mtproto/errors';
import { Api, type Tl } from '../mtproto/tl';
import type { ChatInviteLink, ChatInviteLinkDraft, ChatInviteLinksOffset } from '../chatManagement';
import type { TelegramPeer } from '../types';
export function chatInviteMethods(context: {
  client: Effect.Effect<MtprotoClient, MtprotoError>;
  inputPeer(peer: TelegramPeer): Tl.TypeInputPeer;
  remember(users: readonly Tl.TypeUser[], chats: readonly Tl.TypeChat[]): void;
}) {
  const map = (invite: Tl.ChatInviteExported): ChatInviteLink => ({
    url: invite.link,
    title: invite.title ?? '',
    adminId: `u:${invite.adminId}`,
    date: invite.date,
    permanent: Boolean(invite.permanent),
    revoked: Boolean(invite.revoked),
    requestNeeded: Boolean(invite.requestNeeded),
    expireDate: invite.expireDate ?? 0,
    usageLimit: invite.usageLimit ?? 0,
    usage: invite.usage ?? 0,
    requested: invite.requested ?? 0,
    paid: Boolean(invite.subscriptionPricing),
  });
  const getChatInviteLinks = Effect.fn('ChatInvites.list')(function* (
    peer: TelegramPeer,
    revoked: boolean = false,
    offset?: ChatInviteLinksOffset,
  ) {
    const result = yield* (yield* context.client).invoke(
      Api.messages.GetExportedChatInvites({
        peer: context.inputPeer(peer),
        adminId: Api.InputUserSelf({}),
        ...(revoked ? { revoked: true } : {}),
        ...(offset ? { offsetDate: offset.date, offsetLink: offset.url } : {}),
        limit: 50,
      }),
    );
    context.remember(result.users, []);
    const links = result.invites.filter((invite) => Api.ChatInviteExported.is(invite)).map(map);
    const last = links.at(-1);
    return {
      links,
      count: result.count,
      nextOffset:
        last && result.invites.length === 50 ? { date: last.date, url: last.url } : undefined,
    };
  });
  const exportChatInviteLink = Effect.fn('ChatInvites.export')(function* (
    peer: TelegramPeer,
    draft: ChatInviteLinkDraft,
  ) {
    const result = yield* (yield* context.client).invoke(
      Api.messages.ExportChatInvite({
        peer: context.inputPeer(peer),
        title: draft.title,
        ...(draft.requestNeeded ? { requestNeeded: true } : {}),
        ...(draft.expireDate ? { expireDate: draft.expireDate } : {}),
        ...(draft.usageLimit && !draft.requestNeeded ? { usageLimit: draft.usageLimit } : {}),
      }),
    );
    if (!Api.ChatInviteExported.is(result))
      return yield* Effect.fail(
        createMtprotoError('protocol', 'Telegram did not return the invitation link.'),
      );
    return map(result);
  });
  const editChatInviteLink = Effect.fn('ChatInvites.edit')(function* (
    peer: TelegramPeer,
    url: string,
    draft: ChatInviteLinkDraft,
  ) {
    const result = yield* (yield* context.client).invoke(
      Api.messages.EditExportedChatInvite({
        peer: context.inputPeer(peer),
        link: url,
        title: draft.title,
        requestNeeded: draft.requestNeeded,
        expireDate: draft.expireDate,
        usageLimit: draft.requestNeeded ? 0 : draft.usageLimit,
      }),
    );
    context.remember(result.users, []);
  });
  const revokeChatInviteLink = Effect.fn('ChatInvites.revoke')(function* (
    peer: TelegramPeer,
    url: string,
  ) {
    const result = yield* (yield* context.client).invoke(
      Api.messages.EditExportedChatInvite({
        peer: context.inputPeer(peer),
        link: url,
        revoked: true,
      }),
    );
    context.remember(result.users, []);
  });
  const deleteChatInviteLink = Effect.fn('ChatInvites.delete')(function* (
    peer: TelegramPeer,
    url: string,
  ) {
    const success = yield* (yield* context.client).invoke(
      Api.messages.DeleteExportedChatInvite({ peer: context.inputPeer(peer), link: url }),
    );
    if (!success)
      return yield* Effect.fail(
        createMtprotoError('rpc', 'The invitation link could not be deleted.'),
      );
  });
  return {
    getChatInviteLinks,
    exportChatInviteLink,
    editChatInviteLink,
    revokeChatInviteLink,
    deleteChatInviteLink,
  };
}
