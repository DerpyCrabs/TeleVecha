import { list as renderList } from 'effectweb';
import type { RichBlock, RichCaption, RichText } from '../../domain/richMessage';
import { component, sequence, view } from 'effectweb';
import { safeExternalUrl } from '../shared/safeUrl';
type SpoilerTextModel = { props: { child: RichText }; revealed: boolean };
type SpoilerTextMessage = { type: 'Revealed'; value: boolean };
const SpoilerText = component<{ child: RichText }, SpoilerTextModel, SpoilerTextMessage>({
  init: (props) => ({ props, revealed: false }),

  update: (model, message) => {
    switch (message.type) {
      case 'Revealed':
        return { model: { ...model, revealed: message.value } };
    }
  },
  view: view((model, send) => {
    const props = model.props;
    return (
      <span
        class="rich-spoiler"
        classList={{ revealed: model.revealed }}
        role="button"
        tabIndex={0}
        aria-label={model.revealed ? 'Revealed spoiler' : 'Hidden spoiler. Activate to reveal.'}
        aria-expanded={model.revealed}
        onClick={() => send({ type: 'Revealed', value: true })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            send({ type: 'Revealed', value: true });
          }
        }}
      >
        <RichInline value={props.child} />
      </span>
    );
  }),
});
const RichInline = view<{ value: RichText }, never>((props, _send) => {
  const value = () => props.value;
  return value().kind === 'text' ? (
    <>{(value() as Extract<RichText, { kind: 'text' }>).text}</>
  ) : value().kind === 'concat' ? (
    <>
      {renderList(
        sequence((value() as Extract<RichText, { kind: 'concat' }>).children),
        (child) => (
          <RichInline value={child} />
        ),
      )}
    </>
  ) : value().kind === 'bold' ? (
    <strong>
      <RichInline value={(value() as Extract<RichText, { kind: 'bold' }>).child} />
    </strong>
  ) : value().kind === 'italic' ? (
    <em>
      <RichInline value={(value() as Extract<RichText, { kind: 'italic' }>).child} />
    </em>
  ) : value().kind === 'underline' ? (
    <u>
      <RichInline value={(value() as Extract<RichText, { kind: 'underline' }>).child} />
    </u>
  ) : value().kind === 'strike' ? (
    <s>
      <RichInline value={(value() as Extract<RichText, { kind: 'strike' }>).child} />
    </s>
  ) : value().kind === 'code' ? (
    <code>
      <RichInline value={(value() as Extract<RichText, { kind: 'code' }>).child} />
    </code>
  ) : value().kind === 'subscript' ? (
    <sub>
      <RichInline value={(value() as Extract<RichText, { kind: 'subscript' }>).child} />
    </sub>
  ) : value().kind === 'superscript' ? (
    <sup>
      <RichInline value={(value() as Extract<RichText, { kind: 'superscript' }>).child} />
    </sup>
  ) : value().kind === 'marked' ? (
    <mark>
      <RichInline value={(value() as Extract<RichText, { kind: 'marked' }>).child} />
    </mark>
  ) : value().kind === 'spoiler' ? (
    <SpoilerText child={(value() as Extract<RichText, { kind: 'spoiler' }>).child} />
  ) : value().kind === 'link' ? (
    <>
      {(() => {
        const link = value() as Extract<RichText, { kind: 'link' }>;
        const href = safeExternalUrl(link.url);
        return href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            <RichInline value={link.child} />
          </a>
        ) : (
          <RichInline value={link.child} />
        );
      })()}
    </>
  ) : value().kind === 'anchor' ? (
    <span id={`rich-${(value() as Extract<RichText, { kind: 'anchor' }>).name}`}>
      <RichInline value={(value() as Extract<RichText, { kind: 'anchor' }>).child} />
    </span>
  ) : value().kind === 'customEmoji' ? (
    <span
      class="rich-custom-emoji"
      data-document-id={(value() as Extract<RichText, { kind: 'customEmoji' }>).documentId}
    >
      {(value() as Extract<RichText, { kind: 'customEmoji' }>).alt}
    </span>
  ) : value().kind === 'math' ? (
    <code class="rich-inline-math">{(value() as Extract<RichText, { kind: 'math' }>).source}</code>
  ) : value().kind === 'date' ? (
    <time
      dateTime={new Date(
        (value() as Extract<RichText, { kind: 'date' }>).timestamp * 1000,
      ).toISOString()}
    >
      <RichInline value={(value() as Extract<RichText, { kind: 'date' }>).child} />
    </time>
  ) : value().kind === 'diff' ? (
    <span class="rich-diff" title="Changed text">
      <RichInline value={(value() as Extract<RichText, { kind: 'diff' }>).child} />
    </span>
  ) : null;
});
const Caption = view<{ value: RichCaption | undefined }, never>((props, _send) => {
  return props.value
    ? ((caption) => (
        <figcaption>
          <RichInline value={caption.text} />
          {caption.credit
            ? ((credit) => (
                <cite>
                  <RichInline value={credit} />
                </cite>
              ))(caption.credit!)
            : null}
        </figcaption>
      ))(props.value!)
    : null;
});
const TextBlock = view<{ block: Extract<RichBlock, { kind: 'text' }> }, never>((props, _send) => {
  const content = () => <RichInline value={props.block.text} />;
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
const RichList = view<{ block: Extract<RichBlock, { kind: 'list' }> }, never>((props, _send) => {
  const items = () =>
    renderList(sequence(props.block.items), (item) => (
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
        {item.text ? ((text) => <RichInline value={text} />)(item.text!) : null}
        {item.blocks
          ? ((blocks) => renderList(sequence(blocks), (block) => <RichBlockView block={block} />))(
              item.blocks!,
            )
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
const RichBlockView = view<{ block: RichBlock }, never>((props, _send) => {
  const block = () => props.block;
  return block().kind === 'text' ? (
    <TextBlock block={block() as Extract<RichBlock, { kind: 'text' }>} />
  ) : block().kind === 'heading' ? (
    <>
      {(() => {
        const heading = block() as Extract<RichBlock, { kind: 'heading' }>;
        const content = <RichInline value={heading.text} />;
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
        <RichInline value={(block() as Extract<RichBlock, { kind: 'pre' }>).text} />
      </code>
    </pre>
  ) : block().kind === 'divider' ? (
    <hr />
  ) : block().kind === 'anchor' ? (
    <span id={`rich-${(block() as Extract<RichBlock, { kind: 'anchor' }>).name}`} />
  ) : block().kind === 'list' ? (
    <RichList block={block() as Extract<RichBlock, { kind: 'list' }>} />
  ) : block().kind === 'quote' ? (
    <>
      {(() => {
        const quote = block() as Extract<RichBlock, { kind: 'quote' }>;
        const content = (
          <>
            {renderList(sequence(quote.blocks), (child) => (
              <RichBlockView block={child} />
            ))}
            {quote.caption
              ? ((caption) => (
                  <cite>
                    <RichInline value={caption} />
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
              <RichInline value={details.title} />
            </summary>
            {renderList(sequence(details.blocks), (child) => (
              <RichBlockView block={child} />
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
            <table classList={{ bordered: table.bordered, striped: table.striped }}>
              {table.title
                ? ((title) => (
                    <caption>
                      <RichInline value={title} />
                    </caption>
                  ))(table.title!)
                : null}
              <tbody>
                {renderList(sequence(table.rows), (row) => (
                  <tr>
                    {renderList(sequence(row), (cell) =>
                      cell.header ? (
                        <th
                          scope="col"
                          colspan={cell.colSpan}
                          rowspan={cell.rowSpan}
                          style={{ 'text-align': cell.align, 'vertical-align': cell.verticalAlign }}
                        >
                          {cell.text ? ((text) => <RichInline value={text} />)(cell.text!) : null}
                        </th>
                      ) : (
                        <td
                          colspan={cell.colSpan}
                          rowspan={cell.rowSpan}
                          style={{ 'text-align': cell.align, 'vertical-align': cell.verticalAlign }}
                        >
                          {cell.text ? ((text) => <RichInline value={text} />)(cell.text!) : null}
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
    <pre class="rich-math" aria-label="Mathematical expression">
      {(block() as Extract<RichBlock, { kind: 'math' }>).source}
    </pre>
  ) : block().kind === 'media' ? (
    <>
      {(() => {
        const media = block() as Extract<RichBlock, { kind: 'media' }>;
        const href = safeExternalUrl(media.url);
        const label = media.mediaKind[0]!.toUpperCase() + media.mediaKind.slice(1);
        return (
          <figure class="rich-media">
            {href ? (
              ((url) => (
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {label}
                </a>
              ))(href!)
            ) : (
              <div class="rich-media-placeholder">{label}</div>
            )}
            <Caption value={media.caption} />
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
              {renderList(sequence(group.blocks), (child) => (
                <RichBlockView block={child} />
              ))}
            </div>
            <Caption value={group.caption} />
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
            <RichInline value={author.author} /> ·{' '}
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
});
export const RichMessageBody = view<{ blocks: RichBlock[]; rtl?: boolean | undefined }, never>(
  (props, _send) => {
    return (
      <section class="rich-message" dir={props.rtl ? 'rtl' : undefined}>
        {renderList(sequence(props.blocks), (block) => (
          <RichBlockView block={block} />
        ))}
      </section>
    );
  },
);
