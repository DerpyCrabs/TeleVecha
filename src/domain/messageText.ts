import type { ChatMessage } from './models';
import type { RichBlock, RichCaption, RichListItem, RichText } from './richMessage';

function richTextToPlainText(value: RichText): string {
  if (value.kind === 'text') return value.text;
  if (value.kind === 'concat') return value.children.map(richTextToPlainText).join('');
  if (value.kind === 'customEmoji') return value.alt;
  if (value.kind === 'math') return value.source;
  return richTextToPlainText(value.child);
}

function captionToPlainText(caption: RichCaption | undefined): string {
  if (!caption) return '';
  return [richTextToPlainText(caption.text), caption.credit && richTextToPlainText(caption.credit)]
    .filter(Boolean)
    .join('\n');
}

function prefixLines(text: string, prefix: string) {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function listItemToPlainText(item: RichListItem, marker: string): string {
  const checkbox = item.checkbox ? `[${item.checked ? 'x' : ' '}] ` : '';
  const text = item.text
    ? richTextToPlainText(item.text)
    : richBlocksToPlainText(item.blocks ?? []);
  const lines = text.split('\n');
  const first = `${marker} ${checkbox}${lines.shift() ?? ''}`.trimEnd();
  const indentation = ' '.repeat(marker.length + 1);
  return [first, ...lines.map((line) => `${indentation}${line}`)].join('\n');
}

function blockToPlainText(block: RichBlock): string {
  if (block.kind === 'text' || block.kind === 'heading' || block.kind === 'pre') {
    return richTextToPlainText(block.text);
  }
  if (block.kind === 'divider') return '---';
  if (block.kind === 'anchor') return '';
  if (block.kind === 'math') return block.source;
  if (block.kind === 'author') return richTextToPlainText(block.author);
  if (block.kind === 'list') {
    return block.items
      .map((item, index) => {
        const marker = item.marker ?? (block.ordered ? `${(block.start ?? 1) + index}.` : '-');
        return listItemToPlainText(item, marker);
      })
      .join('\n');
  }
  if (block.kind === 'quote') {
    const quote = prefixLines(richBlocksToPlainText(block.blocks), '> ');
    const caption = block.caption ? richTextToPlainText(block.caption) : '';
    return [quote, caption].filter(Boolean).join('\n');
  }
  if (block.kind === 'details') {
    return [richTextToPlainText(block.title), richBlocksToPlainText(block.blocks)]
      .filter(Boolean)
      .join('\n');
  }
  if (block.kind === 'table') {
    const rows = block.rows.map((row) =>
      row.map((cell) => (cell.text ? richTextToPlainText(cell.text) : '')).join('\t'),
    );
    return [block.title && richTextToPlainText(block.title), ...rows].filter(Boolean).join('\n');
  }
  if (block.kind === 'media') {
    return captionToPlainText(block.caption);
  }
  const content = richBlocksToPlainText(block.blocks);
  return [content, captionToPlainText(block.caption)].filter(Boolean).join('\n');
}

export function richBlocksToPlainText(blocks: RichBlock[]): string {
  return blocks.map(blockToPlainText).filter(Boolean).join('\n\n');
}

export function messageTextForClipboard(
  message: Pick<ChatMessage, 'body' | 'richMessage'>,
): string {
  return message.richMessage ? richBlocksToPlainText(message.richMessage.blocks) : message.body;
}
