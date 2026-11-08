import { BotKeyboard } from '../bots/BotKeyboard';
import type { Effect } from 'effect';
import type {
  TelegramMedia,
  TelegramTransferProgress,
  TelegramBotButton,
} from '../../telegram/types';
import { MediaAttachment } from '../media/MediaAttachment';
import { MathFormula } from './MathFormula';
import { list } from 'effectweb';
import type { RichBlock, RichCaption, RichText } from '../../domain/richMessage';
import { component, sequence, view } from 'effectweb';
import { safeExternalUrl } from '../shared/safeUrl';
export interface RichMediaContext {
  press?: ((button: TelegramBotButton) => void) | undefined;
  load: (
    media: TelegramMedia,
    progress?: TelegramTransferProgress,
  ) => Effect.Effect<string, unknown>;
  protected?: boolean | undefined;
}
type SpoilerTextState = { revealed: boolean };
type SpoilerTextMessage = { type: 'Revealed'; value: boolean };
const SpoilerText = component<
  { child: RichText; media?: RichMediaContext | undefined },
  SpoilerTextState,
  SpoilerTextMessage
>(
  {
    init: () => ({ revealed: false }),
    update: (model, message) => {
      switch (message.type) {
        case 'Revealed':
          return { model: { ...model, revealed: message.value } };
      }
    },
  },
  view((model, send) => {
    const props = model.props;
    return (
      <span
        class="rich-spoiler"
        classList={{ revealed: model.revealed }}
        role="button"
        tabIndex={0}
        aria-label={model.revealed ? 'Revealed spoiler' : 'Hidden spoiler. Activate to reveal.'}
        aria-expanded={model.revealed}
        onClick={(event) => {
          if (!model.revealed) {
            event.preventDefault();
            event.stopPropagation();
            send({ type: 'Revealed', value: true });
          }
        }}
        onKeyDown={(event) => {
          if (!model.revealed && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            send({ type: 'Revealed', value: true });
          }
        }}
      >
        <RichInline media={props.media} value={props.child} />
      </span>
    );
  }),
);
const RichInline = view<{ value: RichText; media?: RichMediaContext | undefined }, never>(
  (props, _send) => {
    const value = () => props.value;
    return value().kind === 'text' ? (
      <>{(value() as Extract<RichText, { kind: 'text' }>).text}</>
    ) : value().kind === 'concat' ? (
      <>
        {list(sequence((value() as Extract<RichText, { kind: 'concat' }>).children), (child) => (
          <RichInline media={props.media} value={child} />
        ))}
      </>
    ) : value().kind === 'bold' ? (
      <strong>
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'bold' }>).child}
        />
      </strong>
    ) : value().kind === 'italic' ? (
      <em>
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'italic' }>).child}
        />
      </em>
    ) : value().kind === 'underline' ? (
      <u>
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'underline' }>).child}
        />
      </u>
    ) : value().kind === 'strike' ? (
      <s>
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'strike' }>).child}
        />
      </s>
    ) : value().kind === 'code' ? (
      <code>
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'code' }>).child}
        />
      </code>
    ) : value().kind === 'subscript' ? (
      <sub>
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'subscript' }>).child}
        />
      </sub>
    ) : value().kind === 'superscript' ? (
      <sup>
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'superscript' }>).child}
        />
      </sup>
    ) : value().kind === 'marked' ? (
      <mark>
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'marked' }>).child}
        />
      </mark>
    ) : value().kind === 'spoiler' ? (
      <SpoilerText
        media={props.media}
        child={(value() as Extract<RichText, { kind: 'spoiler' }>).child}
      />
    ) : value().kind === 'button' ? (
      <button
        type="button"
        class="rich-inline-button"
        disabled={
          !props.media?.press ||
          ['disabled', 'unsupported'].includes(
            (value() as Extract<RichText, { kind: 'button' }>).button.kind,
          )
        }
        onClick={() =>
          props.media?.press?.((value() as Extract<RichText, { kind: 'button' }>).button)
        }
      >
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'button' }>).child}
        />
      </button>
    ) : value().kind === 'command' ? (
      <button
        type="button"
        class="message-bot-command"
        data-bot-command={(value() as Extract<RichText, { kind: 'command' }>).command}
        title={`Send ${(value() as Extract<RichText, { kind: 'command' }>).command}`}
      >
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'command' }>).child}
        />
      </button>
    ) : value().kind === 'link' ? (
      <>
        {(() => {
          const link = value() as Extract<RichText, { kind: 'link' }>;
          const href = safeExternalUrl(link.url);
          return href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              <RichInline media={props.media} value={link.child} />
            </a>
          ) : (
            <RichInline media={props.media} value={link.child} />
          );
        })()}
      </>
    ) : value().kind === 'anchor' ? (
      <span id={`rich-${(value() as Extract<RichText, { kind: 'anchor' }>).name}`}>
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'anchor' }>).child}
        />
      </span>
    ) : value().kind === 'customEmoji' ? (
      <span
        class="rich-custom-emoji"
        data-document-id={(value() as Extract<RichText, { kind: 'customEmoji' }>).documentId}
      >
        {(value() as Extract<RichText, { kind: 'customEmoji' }>).alt}
      </span>
    ) : value().kind === 'math' ? (
      <MathFormula source={(value() as Extract<RichText, { kind: 'math' }>).source} />
    ) : value().kind === 'date' ? (
      <time
        dateTime={new Date(
          (value() as Extract<RichText, { kind: 'date' }>).timestamp * 1000,
        ).toISOString()}
      >
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'date' }>).child}
        />
      </time>
    ) : value().kind === 'diff' ? (
      <span class="rich-diff" title="Changed text">
        <RichInline
          media={props.media}
          value={(value() as Extract<RichText, { kind: 'diff' }>).child}
        />
      </span>
    ) : null;
  },
);
const Caption = view<
  { value: RichCaption | undefined; media?: RichMediaContext | undefined },
  never
>((props, _send) => {
  return props.value
    ? ((caption) => (
        <figcaption>
          <RichInline media={props.media} value={caption.text} />
          {caption.credit
            ? ((credit) => (
                <cite>
                  <RichInline media={props.media} value={credit} />
                </cite>
              ))(caption.credit!)
            : null}
        </figcaption>
      ))(props.value!)
    : null;
});
const TextBlock = view<
  { block: Extract<RichBlock, { kind: 'text' }>; media?: RichMediaContext | undefined },
  never
>((props, _send) => {
  const content = () => <RichInline media={props.media} value={props.block.text} />;
  return props.block.role === 'title' ? (
    <h1 class="rich-title">{content()}</h1>
  ) : props.block.role === 'subtitle' ? (
    <p class="rich-subtitle">{content()}</p>
  ) : props.block.role === 'header' ? (
    <h2>{content()}</h2>
  ) : props.block.role === 'subheader' ? (
    <h3>{content()}</h3>
  ) : props.block.role === 'footer' ? (
    <footer>{content()}</footer>
  ) : props.block.role === 'kicker' ? (
    <p class="rich-kicker">{content()}</p>
  ) : props.block.role === 'thinking' ? (
    <p class="rich-thinking">{content()}</p>
  ) : (
    <p>{content()}</p>
  );
});
const RichList = view<
  { block: Extract<RichBlock, { kind: 'list' }>; media?: RichMediaContext | undefined },
  never
>((props, _send) => {
  const items = () =>
    list(sequence(props.block.items), (item) => (
      <li value={item.value}>
        {item.checkbox ? (
          <input
            type="checkbox"
            checked={item.checked}
            disabled
            aria-label={item.checked ? 'Completed' : 'Not completed'}
          />
        ) : null}
        {item.marker ? <span class="rich-list-marker">{item.marker}</span> : null}
        {item.text ? ((text) => <RichInline media={props.media} value={text} />)(item.text!) : null}
        {item.blocks
          ? ((blocks) =>
              list(sequence(blocks), (block) => (
                <RichBlockView block={block} media={props.media} />
              )))(item.blocks!)
          : null}
      </li>
    ));
  return props.block.ordered ? (
    <ol reversed={props.block.reversed} start={props.block.start}>
      {items()}
    </ol>
  ) : (
    <ul>{items()}</ul>
  );
});
const RichBlockView = view<{ block: RichBlock; media?: RichMediaContext | undefined }, never>(
  (props, _send) => {
    const block = () => props.block;
    return block().kind === 'text' ? (
      <TextBlock media={props.media} block={block() as Extract<RichBlock, { kind: 'text' }>} />
    ) : block().kind === 'heading' ? (
      <>
        {(() => {
          const heading = block() as Extract<RichBlock, { kind: 'heading' }>;
          const content = <RichInline media={props.media} value={heading.text} />;
          return heading.level === 1 ? (
            <h1>{content}</h1>
          ) : heading.level === 2 ? (
            <h2>{content}</h2>
          ) : heading.level === 3 ? (
            <h3>{content}</h3>
          ) : heading.level === 4 ? (
            <h4>{content}</h4>
          ) : heading.level === 5 ? (
            <h5>{content}</h5>
          ) : (
            <h6>{content}</h6>
          );
        })()}
      </>
    ) : block().kind === 'pre' ? (
      <pre data-language={(block() as Extract<RichBlock, { kind: 'pre' }>).language}>
        <code>
          <RichInline
            media={props.media}
            value={(block() as Extract<RichBlock, { kind: 'pre' }>).text}
          />
        </code>
      </pre>
    ) : block().kind === 'divider' ? (
      <hr />
    ) : block().kind === 'anchor' ? (
      <span id={`rich-${(block() as Extract<RichBlock, { kind: 'anchor' }>).name}`} />
    ) : block().kind === 'list' ? (
      <RichList block={block() as Extract<RichBlock, { kind: 'list' }>} media={props.media} />
    ) : block().kind === 'quote' ? (
      <>
        {(() => {
          const quote = block() as Extract<RichBlock, { kind: 'quote' }>;
          const content = (
            <>
              {list(sequence(quote.blocks), (child) => (
                <RichBlockView block={child} media={props.media} />
              ))}
              {quote.caption
                ? ((caption) => (
                    <cite>
                      <RichInline media={props.media} value={caption} />
                    </cite>
                  ))(quote.caption!)
                : null}
            </>
          );
          return quote.expandable ? (
            <details class="rich-quote rich-expandable-quote">
              <summary>Show quote</summary>
              <blockquote>{content}</blockquote>
            </details>
          ) : (
            <blockquote classList={{ 'rich-pullquote': quote.pull }}>{content}</blockquote>
          );
        })()}
      </>
    ) : block().kind === 'details' ? (
      <>
        {(() => {
          const details = block() as Extract<RichBlock, { kind: 'details' }>;
          return (
            <details open={details.open}>
              <summary>
                <RichInline media={props.media} value={details.title} />
              </summary>
              {list(sequence(details.blocks), (child) => (
                <RichBlockView block={child} media={props.media} />
              ))}
            </details>
          );
        })()}
      </>
    ) : block().kind === 'table' ? (
      <>
        {(() => {
          const table = block() as Extract<RichBlock, { kind: 'table' }>;
          return (
            <div class="rich-table-scroll">
              <table
                classList={{
                  bordered: table.bordered,
                  striped: table.striped,
                  compact: table.compact,
                }}
              >
                {table.title
                  ? ((title) => (
                      <caption>
                        <RichInline media={props.media} value={title} />
                      </caption>
                    ))(table.title!)
                  : null}
                <tbody>
                  {list(sequence(table.rows), (row) => (
                    <tr>
                      {list(sequence(row), (cell) =>
                        cell.header ? (
                          <th
                            scope="col"
                            colspan={cell.colSpan}
                            rowspan={cell.rowSpan}
                            style={{
                              'text-align': cell.align,
                              'vertical-align': cell.verticalAlign,
                            }}
                          >
                            {cell.text
                              ? ((text) => <RichInline media={props.media} value={text} />)(
                                  cell.text!,
                                )
                              : null}
                          </th>
                        ) : (
                          <td
                            colspan={cell.colSpan}
                            rowspan={cell.rowSpan}
                            style={{
                              'text-align': cell.align,
                              'vertical-align': cell.verticalAlign,
                            }}
                          >
                            {cell.text
                              ? ((text) => <RichInline media={props.media} value={text} />)(
                                  cell.text!,
                                )
                              : null}
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })()}
      </>
    ) : block().kind === 'math' ? (
      <MathFormula block source={(block() as Extract<RichBlock, { kind: 'math' }>).source} />
    ) : block().kind === 'buttons' ? (
      <div
        class="rich-button-row"
        data-align={(block() as Extract<RichBlock, { kind: 'buttons' }>).align}
      >
        <BotKeyboard
          keyboard={{
            kind: 'inline',
            rows: [(block() as Extract<RichBlock, { kind: 'buttons' }>).buttons],
          }}
          label="Message actions"
          disabled={!props.media?.press}
          onPress={(button) => props.media?.press?.(button)}
        />
      </div>
    ) : block().kind === 'media' ? (
      <>
        {(() => {
          const media = block() as Extract<RichBlock, { kind: 'media' }>;
          const href = safeExternalUrl(media.url);
          const label = media.mediaKind[0]!.toUpperCase() + media.mediaKind.slice(1);
          return (
            <figure class="rich-media">
              {media.attachment && props.media ? (
                <MediaAttachment
                  media={media.attachment}
                  protected={props.media.protected}
                  load={(progress) => props.media!.load(media.attachment!, progress)}
                />
              ) : href ? (
                ((url) => (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {label}
                  </a>
                ))(href!)
              ) : (
                <div class="rich-media-placeholder">{media.attachment?.name ?? label}</div>
              )}
              <Caption media={props.media} value={media.caption} />
            </figure>
          );
        })()}
      </>
    ) : block().kind === 'group' ? (
      <>
        {(() => {
          const group = block() as Extract<RichBlock, { kind: 'group' }>;
          return (
            <figure class={`rich-group rich-${group.mode}`}>
              <div>
                {list(sequence(group.blocks), (child) => (
                  <RichBlockView block={child} media={props.media} />
                ))}
              </div>
              <Caption media={props.media} value={group.caption} />
            </figure>
          );
        })()}
      </>
    ) : block().kind === 'author' ? (
      <>
        {(() => {
          const author = block() as Extract<RichBlock, { kind: 'author' }>;
          return (
            <p class="rich-author">
              <RichInline media={props.media} value={author.author} /> ·{' '}
              <time dateTime={new Date(author.publishedAt * 1000).toISOString()}>
                {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                  new Date(author.publishedAt * 1000),
                )}
              </time>
            </p>
          );
        })()}
      </>
    ) : null;
  },
);
export const RichMessageBody = view<
  { blocks: readonly RichBlock[]; rtl?: boolean | undefined; media?: RichMediaContext | undefined },
  never
>((props, _send) => {
  return (
    <section class="rich-message" dir={props.rtl ? 'rtl' : undefined}>
      {list(sequence(props.blocks), (block) => (
        <RichBlockView block={block} media={props.media} />
      ))}
    </section>
  );
});
