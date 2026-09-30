import { list } from 'effectweb';
import { Effect } from 'effect';
import type { ChatMessage } from '../../domain/models';
import type { TelegramReactionPeople, TelegramReactionPerson } from '../../telegram/types';
import Reply from '@effectweb/lucide/icons/reply';
import SmilePlus from '@effectweb/lucide/icons/smile-plus';
import { TgsPlayer } from '../media/TgsPlayer';
import { VisibilityVideo } from '../media/VisibilityVideo';
import { Avatar } from '../shared/Avatar';
import type * as AsyncResult from 'effect/reactivity/AsyncResult';
import {
  available,
  collection,
  component,
  domMount,
  observe,
  sequence,
  view,
  type Snapshot,
  type Source,
} from 'effectweb';
import type { CustomEmojiAsset } from '../app/queries';
const reactionRows = collection<NonNullable<ChatMessage['reactions']>[number]>(
  (reaction) => reaction.customEmojiId ?? reaction.emoji,
).from;
// Optional details load without failing: an unavailable asset is `undefined`.
type Optional<A> = Source<AsyncResult.AsyncResult<Snapshot<A> | undefined, never>>;
interface MessageActionsProps {
  message: ChatMessage;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  react: (emoji: string) => void;
  /** Who reacted; `revision` changes with the reaction count so the list reloads. */
  reactionPeople: (emoji: string, revision: string) => Optional<TelegramReactionPeople>;
  loadReactionAvatar: (
    person: TelegramReactionPerson,
    cachedOnly: boolean,
  ) => Effect.Effect<string | undefined, unknown>;
  reply: (article: HTMLElement) => void;
  customEmoji?: ((documentId: string) => Optional<CustomEmojiAsset>) | undefined;
}
const customReaction = (asset: Snapshot<CustomEmojiAsset> | undefined) =>
  asset ? (
    asset.mimeType === 'application/x-tgsticker' ? (
      <TgsPlayer source={asset.url} label="Custom emoji reaction" />
    ) : asset.mimeType.startsWith('video/') ? (
      <VisibilityVideo source={asset.url} label="Custom emoji reaction" />
    ) : (
      <img draggable={false} src={asset.url} alt="" />
    )
  ) : (
    <span class="custom-reaction-placeholder" />
  );
const CustomReaction = view<{ asset?: Optional<CustomEmojiAsset> | undefined }>((props) =>
  props.asset
    ? observe(props.asset, (result) => customReaction(available(result)))
    : customReaction(undefined),
);
const peopleRows = collection<TelegramReactionPerson>((person) => person.id).from;
const placeReactionPicker = domMount<HTMLDivElement>((element) => {
  const message = element.closest<HTMLElement>('.message');
  const scroller = element.closest<HTMLElement>('[data-testid="message-scroller"]');
  if (!message || !scroller) return () => {};
  const height = element.offsetHeight;
  const roomAbove = message.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  if (height > 0 && roomAbove < height + 8) element.classList.add('below');
  return () => {};
});
const ReactionPeople = view<{
  people: Optional<TelegramReactionPeople>;
  loadAvatar: MessageActionsProps['loadReactionAvatar'];
}>((props) =>
  observe(props.people, (people) => {
    const result = () => available(people);
    return (
      <span class="reaction-people-content">
        {result()
          ? ((page) => (
              <>
                {page.anonymous ? (
                  'Reactions are anonymous'
                ) : page.people.length ? (
                  <>
                    {list(peopleRows(page.people), (person) => (
                      <span class="reaction-person">
                        <span class="reaction-person-avatar" aria-hidden="true">
                          <Avatar
                            identity={`${person.id}:${person.avatarId ?? 'none'}`}
                            initials={person.initials}
                            color={person.color}
                            size="sm"
                            loadCached={
                              person.hasAvatar ? () => props.loadAvatar(person, true) : undefined
                            }
                            load={
                              person.hasAvatar ? () => props.loadAvatar(person, false) : undefined
                            }
                          />
                        </span>
                        <span>{person.name}</span>
                      </span>
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
          : people.waiting
            ? 'Loading…'
            : 'Could not load reaction details'}
      </span>
    );
  }),
);
interface ReactionButtonProps {
  message: ChatMessage;
  reaction: NonNullable<ChatMessage['reactions']>[number];
  react: MessageActionsProps['react'];
  people: MessageActionsProps['reactionPeople'];
  loadAvatar: MessageActionsProps['loadReactionAvatar'];
  customEmoji: MessageActionsProps['customEmoji'];
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
            <CustomReaction asset={props.customEmoji?.(reaction.customEmojiId!)} />
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
              people={props.people(reaction.emoji, `${reaction.count}:${reaction.chosen}`)}
              loadAvatar={props.loadAvatar}
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
      {list(reactionRows(props.message.reactions ?? []), (reaction) => (
        <ReactionButton
          message={props.message}
          reaction={reaction}
          react={props.react}
          people={props.reactionPeople}
          loadAvatar={props.loadReactionAvatar}
          customEmoji={props.customEmoji}
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
            <div
              class="reaction-picker"
              role="dialog"
              aria-label="Choose reaction"
              use={placeReactionPicker}
            >
              {list(sequence(['👍', '❤️', '😂', '😮', '😢', '🔥']), (emoji) => (
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
