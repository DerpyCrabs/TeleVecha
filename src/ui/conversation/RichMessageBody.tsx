import { For, Match, Show, Switch, createSignal } from 'solid-js';

import type { RichBlock, RichCaption, RichText } from '../../domain/richMessage';
import { safeExternalUrl } from '../shared/safeUrl';

function SpoilerText(props: { child: RichText }) {
  const [revealed, setRevealed] = createSignal(false);
  return (
    <span
      class="rich-spoiler"
      classList={{ revealed: revealed() }}
      role="button"
      tabIndex={0}
      aria-label={revealed() ? 'Revealed spoiler' : 'Hidden spoiler. Activate to reveal.'}
      aria-expanded={revealed()}
      onClick={() => setRevealed(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setRevealed(true);
        }
      }}
    >
      <RichInline value={props.child} />
    </span>
  );
}

function RichInline(props: { value: RichText }) {
  const value = () => props.value;
  return (
    <Switch>
      <Match when={value().kind === 'text'}>
        {(value() as Extract<RichText, { kind: 'text' }>).text}
      </Match>
      <Match when={value().kind === 'concat'}>
        <For each={(value() as Extract<RichText, { kind: 'concat' }>).children}>
          {(child) => <RichInline value={child} />}
        </For>
      </Match>
      <Match when={value().kind === 'bold'}>
        <strong>
          <RichInline value={(value() as Extract<RichText, { kind: 'bold' }>).child} />
        </strong>
      </Match>
      <Match when={value().kind === 'italic'}>
        <em>
          <RichInline value={(value() as Extract<RichText, { kind: 'italic' }>).child} />
        </em>
      </Match>
      <Match when={value().kind === 'underline'}>
        <u>
          <RichInline value={(value() as Extract<RichText, { kind: 'underline' }>).child} />
        </u>
      </Match>
      <Match when={value().kind === 'strike'}>
        <s>
          <RichInline value={(value() as Extract<RichText, { kind: 'strike' }>).child} />
        </s>
      </Match>
      <Match when={value().kind === 'code'}>
        <code>
          <RichInline value={(value() as Extract<RichText, { kind: 'code' }>).child} />
        </code>
      </Match>
      <Match when={value().kind === 'subscript'}>
        <sub>
          <RichInline value={(value() as Extract<RichText, { kind: 'subscript' }>).child} />
        </sub>
      </Match>
      <Match when={value().kind === 'superscript'}>
        <sup>
          <RichInline value={(value() as Extract<RichText, { kind: 'superscript' }>).child} />
        </sup>
      </Match>
      <Match when={value().kind === 'marked'}>
        <mark>
          <RichInline value={(value() as Extract<RichText, { kind: 'marked' }>).child} />
        </mark>
      </Match>
      <Match when={value().kind === 'spoiler'}>
        <SpoilerText child={(value() as Extract<RichText, { kind: 'spoiler' }>).child} />
      </Match>
      <Match when={value().kind === 'link'}>
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
      </Match>
      <Match when={value().kind === 'anchor'}>
        <span id={`rich-${(value() as Extract<RichText, { kind: 'anchor' }>).name}`}>
          <RichInline value={(value() as Extract<RichText, { kind: 'anchor' }>).child} />
        </span>
      </Match>
      <Match when={value().kind === 'customEmoji'}>
        <span
          class="rich-custom-emoji"
          data-document-id={(value() as Extract<RichText, { kind: 'customEmoji' }>).documentId}
        >
          {(value() as Extract<RichText, { kind: 'customEmoji' }>).alt}
        </span>
      </Match>
      <Match when={value().kind === 'math'}>
        <code class="rich-inline-math">
          {(value() as Extract<RichText, { kind: 'math' }>).source}
        </code>
      </Match>
      <Match when={value().kind === 'date'}>
        <time
          dateTime={new Date(
            (value() as Extract<RichText, { kind: 'date' }>).timestamp * 1000,
          ).toISOString()}
        >
          <RichInline value={(value() as Extract<RichText, { kind: 'date' }>).child} />
        </time>
      </Match>
      <Match when={value().kind === 'diff'}>
        <span class="rich-diff" title="Changed text">
          <RichInline value={(value() as Extract<RichText, { kind: 'diff' }>).child} />
        </span>
      </Match>
    </Switch>
  );
}

function Caption(props: { value: RichCaption | undefined }) {
  return (
    <Show when={props.value}>
      {(caption) => (
        <figcaption>
          <RichInline value={caption().text} />
          <Show when={caption().credit}>
            {(credit) => (
              <cite>
                <RichInline value={credit()} />
              </cite>
            )}
          </Show>
        </figcaption>
      )}
    </Show>
  );
}

function TextBlock(props: { block: Extract<RichBlock, { kind: 'text' }> }) {
  const content = () => <RichInline value={props.block.text} />;
  return (
    <Switch fallback={<p>{content()}</p>}>
      <Match when={props.block.role === 'title'}>
        <h1 class="rich-title">{content()}</h1>
      </Match>
      <Match when={props.block.role === 'subtitle'}>
        <p class="rich-subtitle">{content()}</p>
      </Match>
      <Match when={props.block.role === 'header'}>
        <h2>{content()}</h2>
      </Match>
      <Match when={props.block.role === 'subheader'}>
        <h3>{content()}</h3>
      </Match>
      <Match when={props.block.role === 'footer'}>
        <footer>{content()}</footer>
      </Match>
      <Match when={props.block.role === 'kicker'}>
        <p class="rich-kicker">{content()}</p>
      </Match>
      <Match when={props.block.role === 'thinking'}>
        <p class="rich-thinking">{content()}</p>
      </Match>
    </Switch>
  );
}

function RichList(props: { block: Extract<RichBlock, { kind: 'list' }> }) {
  const items = () => (
    <For each={props.block.items}>
      {(item) => (
        <li value={item.value}>
          <Show when={item.checkbox}>
            <input
              type="checkbox"
              checked={item.checked}
              disabled
              aria-label={item.checked ? 'Completed' : 'Not completed'}
            />
          </Show>
          <Show when={item.marker}>
            <span class="rich-list-marker">{item.marker}</span>
          </Show>
          <Show when={item.text}>{(text) => <RichInline value={text()} />}</Show>
          <Show when={item.blocks}>
            {(blocks) => <For each={blocks()}>{(block) => <RichBlockView block={block} />}</For>}
          </Show>
        </li>
      )}
    </For>
  );
  return props.block.ordered ? (
    <ol reversed={props.block.reversed} start={props.block.start}>
      {items()}
    </ol>
  ) : (
    <ul>{items()}</ul>
  );
}

function RichBlockView(props: { block: RichBlock }) {
  const block = () => props.block;
  return (
    <Switch>
      <Match when={block().kind === 'text'}>
        <TextBlock block={block() as Extract<RichBlock, { kind: 'text' }>} />
      </Match>
      <Match when={block().kind === 'heading'}>
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
      </Match>
      <Match when={block().kind === 'pre'}>
        <pre data-language={(block() as Extract<RichBlock, { kind: 'pre' }>).language}>
          <code>
            <RichInline value={(block() as Extract<RichBlock, { kind: 'pre' }>).text} />
          </code>
        </pre>
      </Match>
      <Match when={block().kind === 'divider'}>
        <hr />
      </Match>
      <Match when={block().kind === 'anchor'}>
        <span id={`rich-${(block() as Extract<RichBlock, { kind: 'anchor' }>).name}`} />
      </Match>
      <Match when={block().kind === 'list'}>
        <RichList block={block() as Extract<RichBlock, { kind: 'list' }>} />
      </Match>
      <Match when={block().kind === 'quote'}>
        {(() => {
          const quote = block() as Extract<RichBlock, { kind: 'quote' }>;
          const content = (
            <>
              <For each={quote.blocks}>{(child) => <RichBlockView block={child} />}</For>
              <Show when={quote.caption}>
                {(caption) => (
                  <cite>
                    <RichInline value={caption()} />
                  </cite>
                )}
              </Show>
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
      </Match>
      <Match when={block().kind === 'details'}>
        {(() => {
          const details = block() as Extract<RichBlock, { kind: 'details' }>;
          return (
            <details open={details.open}>
              <summary>
                <RichInline value={details.title} />
              </summary>
              <For each={details.blocks}>{(child) => <RichBlockView block={child} />}</For>
            </details>
          );
        })()}
      </Match>
      <Match when={block().kind === 'table'}>
        {(() => {
          const table = block() as Extract<RichBlock, { kind: 'table' }>;
          return (
            <div class="rich-table-scroll">
              <table classList={{ bordered: table.bordered, striped: table.striped }}>
                <Show when={table.title}>
                  {(title) => (
                    <caption>
                      <RichInline value={title()} />
                    </caption>
                  )}
                </Show>
                <tbody>
                  <For each={table.rows}>
                    {(row) => (
                      <tr>
                        <For each={row}>
                          {(cell) =>
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
                                <Show when={cell.text}>
                                  {(text) => <RichInline value={text()} />}
                                </Show>
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
                                <Show when={cell.text}>
                                  {(text) => <RichInline value={text()} />}
                                </Show>
                              </td>
                            )
                          }
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          );
        })()}
      </Match>
      <Match when={block().kind === 'math'}>
        <pre class="rich-math" aria-label="Mathematical expression">
          {(block() as Extract<RichBlock, { kind: 'math' }>).source}
        </pre>
      </Match>
      <Match when={block().kind === 'media'}>
        {(() => {
          const media = block() as Extract<RichBlock, { kind: 'media' }>;
          const href = safeExternalUrl(media.url);
          const label = media.mediaKind[0]!.toUpperCase() + media.mediaKind.slice(1);
          return (
            <figure class="rich-media">
              <Show when={href} fallback={<div class="rich-media-placeholder">{label}</div>}>
                {(url) => (
                  <a href={url()} target="_blank" rel="noopener noreferrer">
                    {label}
                  </a>
                )}
              </Show>
              <Caption value={media.caption} />
            </figure>
          );
        })()}
      </Match>
      <Match when={block().kind === 'group'}>
        {(() => {
          const group = block() as Extract<RichBlock, { kind: 'group' }>;
          return (
            <figure class={`rich-group rich-${group.mode}`}>
              <div>
                <For each={group.blocks}>{(child) => <RichBlockView block={child} />}</For>
              </div>
              <Caption value={group.caption} />
            </figure>
          );
        })()}
      </Match>
      <Match when={block().kind === 'author'}>
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
      </Match>
    </Switch>
  );
}

export function RichMessageBody(props: { blocks: RichBlock[]; rtl?: boolean | undefined }) {
  return (
    <section class="rich-message" dir={props.rtl ? 'rtl' : undefined}>
      <For each={props.blocks}>{(block) => <RichBlockView block={block} />}</For>
    </section>
  );
}
