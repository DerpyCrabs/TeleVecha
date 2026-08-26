import Reply from 'lucide-solid/icons/reply';
import SmilePlus from 'lucide-solid/icons/smile-plus';
import { For, Show, createEffect, createSignal } from 'solid-js';

import type { ChatMessage } from '../domain/models';
import { TgsPlayer } from './TgsPlayer';
import { VisibilityVideo } from './VisibilityVideo';

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
  loadCustomEmoji?: ((documentId: string) => Promise<CustomEmojiAsset>) | undefined;
}

function CustomReaction(props: {
  documentId: string;
  load?: ((documentId: string) => Promise<CustomEmojiAsset>) | undefined;
}) {
  const [asset, setAsset] = createSignal<CustomEmojiAsset>();
  createEffect(() => {
    const documentId = props.documentId;
    const load = props.load;
    setAsset(undefined);
    if (!load) return;
    void load(documentId).then(setAsset, () => undefined);
  });
  return (
    <Show when={asset()} fallback={<span class="custom-reaction-placeholder" />}>
      {(loaded) => (
        <Show
          when={loaded().mimeType === 'application/x-tgsticker'}
          fallback={
            loaded().mimeType.startsWith('video/') ? (
              <VisibilityVideo source={loaded().url} label="Custom emoji reaction" />
            ) : (
              <img src={loaded().url} alt="" />
            )
          }
        >
          <TgsPlayer source={loaded().url} label="Custom emoji reaction" />
        </Show>
      )}
    </Show>
  );
}

export function MessageActions(props: MessageActionsProps) {
  const reply = (event: PointerEvent & { currentTarget: HTMLButtonElement }) => {
    event.preventDefault();
    const article = event.currentTarget.closest<HTMLElement>('article.message');
    if (article) props.reply(article);
  };

  return (
    <div class="message-reactions">
      <For each={props.message.reactions}>
        {(reaction) => (
          <button
            class="reaction"
            classList={{ chosen: reaction.chosen }}
            onClick={() => props.react(reaction.emoji)}
            aria-label={`${reaction.chosen ? 'Remove' : 'Add'} ${reaction.customEmojiId ? 'custom emoji' : reaction.emoji} reaction`}
          >
            <Show when={reaction.customEmojiId} fallback={<span>{reaction.emoji}</span>}>
              {(documentId) => (
                <CustomReaction documentId={documentId()} load={props.loadCustomEmoji} />
              )}
            </Show>
            <b>{reaction.count}</b>
          </button>
        )}
      </For>
      <Show when={Number.isSafeInteger(Number(props.message.id))}>
        <button
          class="reply-message"
          onPointerDown={reply}
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
        <Show when={props.pickerOpen}>
          <div class="reaction-picker" role="dialog" aria-label="Choose reaction">
            <For each={['👍', '❤️', '😂', '😮', '😢', '🔥']}>
              {(emoji) => (
                <button onClick={() => props.react(emoji)} aria-label={`React with ${emoji}`}>
                  {emoji}
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
