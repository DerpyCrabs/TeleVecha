import { describe, expect, it } from 'vitest';

import type { RichMessage } from './richMessage';
import { messageTextForClipboard, richBlocksToPlainText } from './messageText';

describe('message text for the clipboard', () => {
  it('copies regular messages without changing their text', () => {
    expect(messageTextForClipboard({ body: 'First line\nSecond line' })).toBe(
      'First line\nSecond line',
    );
  });

  it('flattens all rich content, including collapsed and hidden text', () => {
    const richMessage: RichMessage = {
      blocks: [
        {
          kind: 'heading',
          level: 2,
          text: { kind: 'bold', child: { kind: 'text', text: 'Rich Markdown' } },
        },
        {
          kind: 'text',
          role: 'paragraph',
          text: {
            kind: 'concat',
            children: [
              { kind: 'text', text: 'Visible ' },
              { kind: 'spoiler', child: { kind: 'text', text: 'secret' } },
              { kind: 'customEmoji', alt: '👍', documentId: '55' },
            ],
          },
        },
        {
          kind: 'list',
          ordered: false,
          items: [{ checkbox: true, checked: true, text: { kind: 'text', text: 'Finished task' } }],
        },
        {
          kind: 'quote',
          expandable: true,
          blocks: [
            {
              kind: 'text',
              role: 'paragraph',
              text: { kind: 'text', text: 'First line\nSecond line' },
            },
          ],
          caption: { kind: 'text', text: 'Source' },
        },
        {
          kind: 'table',
          title: { kind: 'text', text: 'Table' },
          rows: [
            [
              { header: true, text: { kind: 'text', text: 'Name' } },
              { header: true, text: { kind: 'text', text: 'Value' } },
            ],
            [
              { text: { kind: 'text', text: 'Answer' } },
              { text: { kind: 'math', source: '6 * 7' } },
            ],
          ],
        },
        {
          kind: 'details',
          title: { kind: 'text', text: 'More' },
          blocks: [
            { kind: 'text', role: 'paragraph', text: { kind: 'text', text: 'Nested content' } },
          ],
        },
      ],
    };

    expect(richBlocksToPlainText(richMessage.blocks)).toBe(
      [
        'Rich Markdown',
        'Visible secret👍',
        '- [x] Finished task',
        '> First line\n> Second line\nSource',
        'Table\nName\tValue\nAnswer\t6 * 7',
        'More\nNested content',
      ].join('\n\n'),
    );
    expect(messageTextForClipboard({ body: 'Raw fallback', richMessage })).toContain(
      'Nested content',
    );
  });
});
