import { list as renderList } from 'effectweb';
import { Effect } from 'effect';
import type { ChatMessage } from '../../domain/models';
import type { TelegramReactionPeople } from '../../telegram/types';
import Reply from '@effectweb/lucide/icons/reply';
import SmilePlus from '@effectweb/lucide/icons/smile-plus';
import { TgsPlayer } from '../media/TgsPlayer';
import { VisibilityVideo } from '../media/VisibilityVideo';
import { available, collection, component, resourceComponent, sequence, view } from 'effectweb';
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
  loadReactionPeople: (emoji: string) => Effect.Effect<TelegramReactionPeople, unknown>;
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
const peopleRows = collection<{ id: string; name: string }>((person) => person.id).from;
const ReactionPeople = resourceComponent<
  { identity: string; load: () => Effect.Effect<TelegramReactionPeople, unknown> },
  TelegramReactionPeople | undefined
>({
  request: (props) => ({
    key: props.identity,
    load: () => props.load().pipe(Effect.catch(() => Effect.succeed(undefined))),
  }),
  view: view((model) => {
    const result = () => available(model.result);
    return (
      <span class="reaction-people-content">
        {result()
          ? ((page) => (
              <>
                {page.anonymous ? (
                  'Reactions are anonymous'
                ) : page.people.length ? (
                  <>
                    {renderList(peopleRows(page.people), (person) => (
                      <span>{person.name}</span>
                    ))}
                    {page.count > page.people.length ? (
                      <small>and {page.count - page.people.length} more</small>
                    ) : null}
                  </>
                ) : (
                  'No reactions yet'
                )}
              </>
            ))(result()!)
          : model.result.waiting
            ? 'Loading…'
            : 'Could not load reaction details'}
      </span>
    );
  }),
});
interface ReactionButtonProps {
  message: ChatMessage;
  reaction: NonNullable<ChatMessage['reactions']>[number];
  react: MessageActionsProps['react'];
  load: MessageActionsProps['loadReactionPeople'];
  loadCustomEmoji: MessageActionsProps['loadCustomEmoji'];
}
const ReactionButton = component<
  ReactionButtonProps,
  {
    props: ReactionButtonProps;
    hovered: boolean;
    focused: boolean;
    left: number;
    top: number;
    above: boolean;
  },
  { type: 'Hover' | 'Focus'; value: boolean; bounds?: DOMRect }
>({
  init: (props) => ({ props, hovered: false, focused: false, left: 0, top: 0, above: false }),
  update: (model, message) => {
    const bounds = message.bounds;
    const above = bounds ? bounds.bottom > window.innerHeight - 240 : model.above;
    return {
      model: {
        ...model,
        [message.type === 'Hover' ? 'hovered' : 'focused']: message.value,
        ...(bounds
          ? {
              left: Math.max(8, Math.min(bounds.left, window.innerWidth - 248)),
              top: above ? bounds.top : bounds.bottom,
              above,
            }
          : {}),
      },
    };
  },
  view: view((model, send) => {
    const props = model.props;
    const reaction = props.reaction;
    const tooltipId = `reaction-people-${props.message.peerId}-${props.message.id}-${encodeURIComponent(reaction.emoji)}`;
    return (
      <span
        class="reaction-with-people"
        onMouseEnter={(event) =>
          send({ type: 'Hover', value: true, bounds: event.currentTarget.getBoundingClientRect() })
        }
        onMouseLeave={() => send({ type: 'Hover', value: false })}
        onFocusIn={(event) =>
          send({ type: 'Focus', value: true, bounds: event.currentTarget.getBoundingClientRect() })
        }
        onFocusOut={() => send({ type: 'Focus', value: false })}
      >
        <button
          class="reaction"
          classList={{ chosen: reaction.chosen }}
          onClick={() => props.react(reaction.emoji)}
          aria-label={`${reaction.chosen ? 'Remove' : 'Add'} ${reaction.customEmojiId ? 'custom emoji' : reaction.emoji} reaction`}
          aria-describedby={model.hovered || model.focused ? tooltipId : undefined}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            send({ type: 'Hover', value: false });
            send({ type: 'Focus', value: false });
          }}
        >
          {reaction.customEmojiId ? (
            <CustomReaction documentId={reaction.customEmojiId!} load={props.loadCustomEmoji} />
          ) : (
            <span>{reaction.emoji}</span>
          )}
          <b>{reaction.count}</b>
        </button>
        {model.hovered || model.focused ? (
          <span
            id={tooltipId}
            role="tooltip"
            class="reaction-people"
            style={{
              left: `${model.left}px`,
              top: `${model.top}px`,
              transform: model.above ? 'translateY(-100%)' : undefined,
            }}
          >
            <ReactionPeople
              identity={`${props.message.peerId}:${props.message.id}:${reaction.emoji}:${reaction.count}:${reaction.chosen}`}
              load={() => props.load(reaction.emoji)}
            />
          </span>
        ) : null}
      </span>
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
      {renderList(reactionRows(props.message.reactions ?? []), (reaction) => (
        <ReactionButton
          message={props.message}
          reaction={reaction}
          react={props.react}
          load={props.loadReactionPeople}
          loadCustomEmoji={props.loadCustomEmoji}
        />
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
              {renderList(sequence(['👍', '❤️', '😂', '😮', '😢', '🔥']), (emoji) => (
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
