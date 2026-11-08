import type { TelegramMedia, TelegramBotButton } from '../telegram/types';
type RichStyledTextKind =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'subscript'
  | 'superscript'
  | 'marked'
  | 'spoiler'
  | 'diff';

type RichStyledText = {
  [Kind in RichStyledTextKind]: { kind: Kind; child: RichText; oldText?: RichText | undefined };
}[RichStyledTextKind];

export type RichText =
  | { kind: 'text'; text: string }
  | { kind: 'concat'; children: readonly RichText[] }
  | RichStyledText
  | { kind: 'link'; child: RichText; url: string }
  | { kind: 'command'; child: RichText; command: string }
  | { kind: 'button'; child: RichText; button: TelegramBotButton }
  | { kind: 'anchor'; child: RichText; name: string }
  | { kind: 'customEmoji'; alt: string; documentId: string }
  | { kind: 'math'; source: string }
  | { kind: 'date'; child: RichText; timestamp: number };

export interface RichCaption {
  text: RichText;
  credit?: RichText | undefined;
}

export interface RichListItem {
  text?: RichText | undefined;
  blocks?: readonly RichBlock[] | undefined;
  checked?: boolean | undefined;
  checkbox?: boolean | undefined;
  marker?: string | undefined;
  value?: number | undefined;
}

export interface RichTableCell {
  text?: RichText | undefined;
  header?: boolean | undefined;
  align?: 'left' | 'center' | 'right' | undefined;
  verticalAlign?: 'top' | 'middle' | 'bottom' | undefined;
  colSpan?: number | undefined;
  rowSpan?: number | undefined;
}

export type RichBlock =
  | { kind: 'buttons'; buttons: readonly TelegramBotButton[]; align: 'left' | 'center' | 'right' }
  | {
      kind: 'text';
      role:
        | 'title'
        | 'subtitle'
        | 'header'
        | 'subheader'
        | 'paragraph'
        | 'footer'
        | 'kicker'
        | 'thinking';
      text: RichText;
    }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: RichText }
  | { kind: 'pre'; text: RichText; language?: string | undefined }
  | { kind: 'divider' }
  | { kind: 'anchor'; name: string }
  | {
      kind: 'list';
      ordered: boolean;
      reversed?: boolean | undefined;
      start?: number | undefined;
      items: readonly RichListItem[];
    }
  | {
      kind: 'quote';
      blocks: readonly RichBlock[];
      caption?: RichText | undefined;
      pull?: boolean | undefined;
      expandable?: boolean | undefined;
    }
  | { kind: 'details'; title: RichText; blocks: readonly RichBlock[]; open?: boolean | undefined }
  | {
      kind: 'table';
      title?: RichText | undefined;
      rows: readonly (readonly RichTableCell[])[];
      bordered?: boolean | undefined;
      compact?: boolean | undefined;
      striped?: boolean | undefined;
    }
  | { kind: 'math'; source: string }
  | {
      kind: 'media';
      mediaKind: 'photo' | 'video' | 'audio' | 'embed' | 'map' | 'file';
      attachment?: TelegramMedia | undefined;
      id?: string | undefined;
      url?: string | undefined;
      caption?: RichCaption | undefined;
      spoiler?: boolean | undefined;
    }
  | {
      kind: 'group';
      mode: 'cover' | 'collage' | 'slideshow';
      blocks: readonly RichBlock[];
      caption?: RichCaption;
    }
  | { kind: 'author'; author: RichText; publishedAt: number };

export interface RichMessage {
  blocks: readonly RichBlock[];
  rtl?: boolean | undefined;
  partial?: boolean | undefined;
}
