import { Effect } from 'effect';
import type { MtprotoClient } from '../mtproto';
import { createMtprotoError, type MtprotoError } from '../mtproto/errors';
import { Api, type Tl } from '../mtproto/tl';
import {
  savedReactionValid,
  type SavedDialogsOffset,
  type SavedDialogsPage,
  type SavedMessagesInfo,
  type SavedReactionTag,
  type SavedTags,
} from '../savedMessages';
import type { TelegramMessage, TelegramPeer, TelegramPeerSearchResult } from '../types';
export function savedReaction(reaction: string): Tl.TypeReaction {
  return reaction.startsWith('custom:')
    ? Api.ReactionCustomEmoji({ documentId: BigInt(reaction.slice(7)) })
    : Api.ReactionEmoji({ emoticon: reaction });
}
export function savedReactionKey(reaction: Tl.TypeReaction): string | undefined {
  return reaction._ === 'reactionEmoji'
    ? reaction.emoticon
    : reaction._ === 'reactionCustomEmoji'
      ? `custom:${reaction.documentId}`
      : undefined;
}
export function savedMessagesMethods(context: {
  client: Effect.Effect<MtprotoClient, MtprotoError>;
  inputPeer(peer: TelegramPeer): Tl.TypeInputPeer;
  peer(peer: Tl.TypePeer): TelegramPeer | undefined;
  person(peer: TelegramPeer): TelegramPeerSearchResult;
  remember(users: readonly Tl.TypeUser[], chats: readonly Tl.TypeChat[]): void;
  message(message: Tl.TypeMessage): TelegramMessage | undefined;
}) {
  const getSavedMessagesInfo = Effect.fn('SavedMessages.info')(function* (): Effect.fn.Return<
    SavedMessagesInfo,
    MtprotoError
  > {
    const self = yield* (yield* context.client).getMe;
    if (!Api.User.is(self))
      return yield* Effect.fail(
        createMtprotoError('configuration', 'Sign in to open Saved Messages.'),
      );
    context.remember([self], []);
    return {
      peer: { id: `u:${self.id}`, kind: 'user', accessHash: self.accessHash?.toString() },
      premium: Boolean(self.premium),
    };
  });
  const getSavedDialogs = Effect.fn('SavedMessages.dialogs')(function* (
    offset?: SavedDialogsOffset,
  ): Effect.fn.Return<SavedDialogsPage, MtprotoError> {
    const info = yield* getSavedMessagesInfo();
    const client = yield* context.client;
    const result = yield* client.invoke(
      Api.messages.GetSavedDialogs({
        excludePinned: true,
        offsetDate: offset?.date ?? 0,
        offsetId: offset?.messageId ?? 0,
        offsetPeer: offset ? context.inputPeer(offset.peer) : Api.InputPeerEmpty(),
        limit: 50,
        hash: 0n,
      }),
    );
    const pinned = offset ? undefined : yield* client.invoke(Api.messages.GetPinnedSavedDialogs());
    const pages = [pinned, result].filter(
      (page): page is Tl.messages.SavedDialogs | Tl.messages.SavedDialogsSlice =>
        !!page && page._ !== 'messages.savedDialogsNotModified',
    );
    for (const page of [...pages].reverse()) context.remember(page.users, page.chats);
    const messages = new Map<number, TelegramMessage>();
    for (const page of [...pages].reverse())
      for (const raw of page.messages) {
        const message = context.message(raw);
        if (message) messages.set(message.id, message);
      }
    const dialogs = pages.flatMap((page) =>
      page.dialogs.flatMap((dialog) => {
        const peer = context.peer(dialog.peer);
        if (!peer) return [];
        const person = context.person(peer);
        const title =
          peer.id === info.peer.id
            ? 'My Notes'
            : peer.id === 'u:2666000'
              ? 'Author hidden'
              : person.title;
        return [
          {
            peer,
            title,
            initials: peer.id === info.peer.id ? 'MN' : person.initials,
            color: person.color,
            hasAvatar:
              peer.id === info.peer.id || peer.id === 'u:2666000' ? false : person.hasAvatar,
            avatarId: person.avatarId,
            pinned: dialog._ === 'savedDialog' && Boolean(dialog.pinned),
            topMessage: messages.get(dialog.topMessage),
          },
        ];
      }),
    );
    const last =
      result._ !== 'messages.savedDialogsNotModified' ? result.dialogs.at(-1) : undefined;
    const lastPeer = last ? context.peer(last.peer) : undefined;
    const nextOffset =
      result._ === 'messages.savedDialogsSlice' && result.dialogs.length >= 50 && last && lastPeer
        ? {
            peer: lastPeer,
            messageId: last.topMessage,
            date: messages.get(last.topMessage)?.date ?? 0,
          }
        : undefined;
    return {
      dialogs: dialogs.filter(
        (dialog, index) => dialogs.findIndex((item) => item.peer.id === dialog.peer.id) === index,
      ),
      nextOffset:
        nextOffset &&
        offset &&
        nextOffset.peer.id === offset.peer.id &&
        nextOffset.messageId === offset.messageId &&
        nextOffset.date === offset.date
          ? undefined
          : nextOffset,
    };
  });
  const getSavedHistory = Effect.fn('SavedMessages.history')(function* (
    source: TelegramPeer,
    limit: number = 50,
    beforeMessageId?: number,
  ) {
    const result = yield* (yield* context.client).invoke(
      Api.messages.GetSavedHistory({
        peer: context.inputPeer(source),
        offsetId: beforeMessageId ?? 0,
        offsetDate: 0,
        addOffset: 0,
        limit: limit + 1,
        maxId: 0,
        minId: 0,
        hash: 0n,
      }),
    );
    if (result._ === 'messages.messagesNotModified') return { messages: [], hasOlder: false };
    context.remember(result.users, result.chats);
    return {
      messages: result.messages
        .slice(0, limit)
        .flatMap((raw) => {
          const message = context.message(raw);
          return message ? [message] : [];
        })
        .sort((a, b) => a.id - b.id),
      hasOlder: result.messages.length > limit,
    };
  });
  const getSavedTags = Effect.fn('SavedMessages.tags')(function* (
    source?: TelegramPeer,
  ): Effect.fn.Return<SavedTags, MtprotoError> {
    const client = yield* context.client;
    const result = yield* client.invoke(
      Api.messages.GetSavedReactionTags({
        ...(source ? { peer: context.inputPeer(source) } : {}),
        hash: 0n,
      }),
    );
    const defaults = yield* client.invoke(Api.messages.GetDefaultTagReactions({ hash: 0n }));
    const tags: SavedReactionTag[] =
      result._ === 'messages.savedReactionTags'
        ? result.tags
            .flatMap((tag) => {
              const reaction = savedReactionKey(tag.reaction);
              return reaction ? [{ reaction, title: tag.title ?? '', count: tag.count }] : [];
            })
            .sort((a, b) => b.count - a.count)
        : [];
    return {
      tags,
      recommended:
        defaults._ === 'messages.reactions'
          ? defaults.reactions.flatMap((reaction) => {
              const key = savedReactionKey(reaction);
              return key && !tags.some((tag) => tag.reaction === key) ? [key] : [];
            })
          : [],
    };
  });
  const renameSavedTag = Effect.fn('SavedMessages.renameTag')(function* (
    reaction: string,
    title: string,
  ) {
    if (!savedReactionValid(reaction))
      return yield* Effect.fail(createMtprotoError('configuration', 'Choose a valid tag.'));
    if (Array.from(title).length > 12)
      return yield* Effect.fail(
        createMtprotoError('configuration', 'Tag names can have up to 12 characters.'),
      );
    const info = yield* getSavedMessagesInfo();
    if (!info.premium)
      return yield* Effect.fail(
        createMtprotoError('configuration', 'Telegram Premium is required to name tags.'),
      );
    const saved = yield* (yield* context.client).invoke(
      Api.messages.UpdateSavedReactionTag({
        reaction: savedReaction(reaction),
        ...(title ? { title } : {}),
      }),
    );
    if (!saved)
      return yield* Effect.fail(createMtprotoError('rpc', 'The tag name could not be saved.'));
  });
  const pinSavedDialog = Effect.fn('SavedMessages.pin')(function* (
    source: TelegramPeer,
    pinned: boolean,
  ) {
    const saved = yield* (yield* context.client).invoke(
      Api.messages.ToggleSavedDialogPin({
        peer: Api.InputDialogPeer({ peer: context.inputPeer(source) }),
        ...(pinned ? { pinned: true } : {}),
      }),
    );
    if (!saved)
      return yield* Effect.fail(createMtprotoError('rpc', 'The saved chat could not be pinned.'));
  });
  const setSavedMessageTags = Effect.fn('SavedMessages.setTags')(function* (
    messageId: number,
    reactions: readonly string[],
  ) {
    if (reactions.some((reaction) => !savedReactionValid(reaction)))
      return yield* Effect.fail(createMtprotoError('configuration', 'Choose valid tags.'));
    const info = yield* getSavedMessagesInfo();
    if (!info.premium)
      return yield* Effect.fail(
        createMtprotoError('configuration', 'Telegram Premium is required to add tags.'),
      );
    return yield* (yield* context.client).invoke(
      Api.messages.SendReaction({
        peer: Api.InputPeerSelf(),
        msgId: messageId,
        reaction: [...new Set(reactions)].map(savedReaction),
        addToRecent: true,
      }),
    );
  });
  return {
    getSavedMessagesInfo,
    getSavedDialogs,
    getSavedHistory,
    getSavedTags,
    renameSavedTag,
    pinSavedDialog,
    setSavedMessageTags,
  };
}
