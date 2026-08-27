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
  [Kind in RichStyledTextKind]: {
    kind: Kind;
    child: RichText;
    oldText?: RichText | undefined;
  };
}[RichStyledTextKind];

export type RichText =
  | { kind: 'text'; text: string }
  | { kind: 'concat'; children: RichText[] }
  | RichStyledText
  | {
      kind: 'link';
      child: RichText;
      url: string;
    }
  | {
      kind: 'anchor';
      child: RichText;
      name: string;
    }
  | {
      kind: 'customEmoji';
      alt: string;
      documentId: string;
    }
  | { kind: 'math'; source: string }
  | {
      kind: 'date';
      child: RichText;
      timestamp: number;
    };

export interface RichCaption {
  text: RichText;
  credit?: RichText | undefined;
}

export interface RichListItem {
  text?: RichText | undefined;
  blocks?: RichBlock[] | undefined;
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
      items: RichListItem[];
    }
  | {
      kind: 'quote';
      blocks: RichBlock[];
      caption?: RichText | undefined;
      pull?: boolean | undefined;
      expandable?: boolean | undefined;
    }
  | {
      kind: 'details';
      title: RichText;
      blocks: RichBlock[];
      open?: boolean | undefined;
    }
  | {
      kind: 'table';
      title?: RichText | undefined;
      rows: RichTableCell[][];
      bordered?: boolean | undefined;
      striped?: boolean | undefined;
    }
  | { kind: 'math'; source: string }
  | {
      kind: 'media';
      mediaKind: 'photo' | 'video' | 'audio' | 'embed' | 'map';
      id?: string | undefined;
      url?: string | undefined;
      caption?: RichCaption | undefined;
      spoiler?: boolean | undefined;
    }
  | {
      kind: 'group';
      mode: 'cover' | 'collage' | 'slideshow';
      blocks: RichBlock[];
      caption?: RichCaption;
    }
  | { kind: 'author'; author: RichText; publishedAt: number };

export interface RichMessage {
  blocks: RichBlock[];
  rtl?: boolean | undefined;
  partial?: boolean | undefined;
}
