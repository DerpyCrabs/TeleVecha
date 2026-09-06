import { Effect } from 'effect';
import type { ChatMessage } from '../../domain/models';
import Reply from '@effectweb/lucide/icons/reply';
import SmilePlus from '@effectweb/lucide/icons/smile-plus';
import { TgsPlayer } from '../media/TgsPlayer';
import { VisibilityVideo } from '../media/VisibilityVideo';
import { available, collection, resourceComponent, sequence, view } from 'effectweb';
const reactionRows = collection<NonNullable<ChatMessage['reactions']>[number]>(
  (reaction) => reaction.customEmojiId ?? reaction.emoji,
).from;
interface CustomEmojiAsset {
  url: string;
  mimeType: string;
}
interface MessageActionsProps {
  message: ChatMessage;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  react: (emoji: string) => void;
  reply: (article: HTMLElement) => void;
  loadCustomEmoji?: ((documentId: string) => Effect.Effect<CustomEmojiAsset, unknown>) | undefined;
}
const CustomReaction = resourceComponent<
  {
    documentId: string;
    load?: ((documentId: string) => Effect.Effect<CustomEmojiAsset, unknown>) | undefined;
  },
  CustomEmojiAsset | undefined
>({
  request: (props) =>
    props.load
      ? {
          key: props.documentId,
          load: () =>
            props.load!(props.documentId).pipe(Effect.catch(() => Effect.succeed(undefined))),
        }
      : undefined,
  view: view((model, _send) => {
    const asset = () => available(model.result);
    return asset() ? (
      ((loaded) =>
        loaded.mimeType === 'application/x-tgsticker' ? (
          <TgsPlayer source={loaded.url} label="Custom emoji reaction" />
        ) : loaded.mimeType.startsWith('video/') ? (
          <VisibilityVideo source={loaded.url} label="Custom emoji reaction" />
        ) : (
          <img src={loaded.url} alt="" />
        ))(asset()!)
    ) : (
      <span class="custom-reaction-placeholder" />
    );
  }),
});
export const MessageActions = view<MessageActionsProps, never>((props, _send) => {
  const reply = (event: { preventDefault(): void; currentTarget: HTMLButtonElement }) => {
    event.preventDefault();
    const article = event.currentTarget.closest<HTMLElement>('article.message');
    if (article) props.reply(article);
  };
  return (
    <div class="message-reactions">
      {reactionRows(props.message.reactions ?? []).map((reaction) => (
        <button
          class="reaction"
          classList={{ chosen: reaction.chosen }}
          onClick={() => props.react(reaction.emoji)}
          aria-label={`${reaction.chosen ? 'Remove' : 'Add'} ${reaction.customEmojiId ? 'custom emoji' : reaction.emoji} reaction`}
        >
          {reaction.customEmojiId ? (
            ((documentId) => (
              <CustomReaction documentId={documentId} load={props.loadCustomEmoji} />
            ))(reaction.customEmojiId!)
          ) : (
            <span>{reaction.emoji}</span>
          )}
          <b>{reaction.count}</b>
        </button>
      ))}
      {Number.isSafeInteger(Number(props.message.id)) ? (
        <>
          <button
            class="reply-message"
            onPointerDown={reply}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              reply(event);
            }}
            aria-label={`Reply to message ${props.message.id}`}
            title="Reply; select text first to quote it"
          >
            <Reply size={14} />
          </button>
          <button
            class="add-reaction"
            onClick={() => props.setPickerOpen(!props.pickerOpen)}
            aria-label={`React to message ${props.message.id}`}
            aria-expanded={props.pickerOpen}
          >
            <SmilePlus size={14} />
          </button>
          {props.pickerOpen ? (
            <div class="reaction-picker" role="dialog" aria-label="Choose reaction">
              {sequence(['👍', '❤️', '😂', '😮', '😢', '🔥']).map((emoji) => (
                <button onClick={() => props.react(emoji)} aria-label={`React with ${emoji}`}>
                  {emoji}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
});
