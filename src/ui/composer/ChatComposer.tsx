import Bold from 'lucide-solid/icons/bold';
import Code from 'lucide-solid/icons/code';
import EyeOff from 'lucide-solid/icons/eye-off';
import FileText from 'lucide-solid/icons/file-text';
import Italic from 'lucide-solid/icons/italic';
import Link2 from 'lucide-solid/icons/link-2';
import Paperclip from 'lucide-solid/icons/paperclip';
import Pencil from 'lucide-solid/icons/pencil';
import Quote from 'lucide-solid/icons/quote';
import SendHorizontal from 'lucide-solid/icons/send-horizontal';
import Smile from 'lucide-solid/icons/smile';
import Strikethrough from 'lucide-solid/icons/strikethrough';
import Underline from 'lucide-solid/icons/underline';
import X from 'lucide-solid/icons/x';
import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';

import type {
  TelegramSticker,
  TelegramStickerPack,
  TelegramTextFormat,
} from '../../telegram/types';
import { ExpressionPicker, type ExpressionTab } from './ExpressionPicker';
import { ImageAttachmentEditor } from './ImageAttachmentEditor';
import { canTransformImage, type StagedAttachment } from './outgoingAttachments';

interface ReplyTarget {
  messageId: number;
  preview: string;
  quoteText?: string | undefined;
}

interface ChatComposerProps {
  conversationId: string;
  draft: string;
  enabled: boolean;
  stickerPickerOpen: boolean;
  stickerPickerLoading: boolean;
  gifPickerOpen: boolean;
  gifPickerLoading: boolean;
  gifs: TelegramSticker[];
  stickerPacks: TelegramStickerPack[];
  reply?: ReplyTarget | undefined;
  editing?: { body: string; mediaName?: string | undefined; hasMedia: boolean } | undefined;
  attachments: StagedAttachment[];
  formats: TelegramTextFormat[];
  placeholder?: string | undefined;
  onDraft: (value: string) => void;
  onFormats: (formats: TelegramTextFormat[]) => void;
  onSend: () => void;
  onAttach: (files: File[]) => void;
  onUpdateAttachment: (
    id: string,
    update: Partial<Pick<StagedAttachment, 'file' | 'sendAs'>>,
  ) => void;
  onRemoveAttachment: (id: string) => void;
  onToggleStickers: () => void;
  onToggleGifs: () => void;
  onLoadSticker: (sticker: TelegramSticker) => Promise<string>;
  stickerUrl: (sticker: TelegramSticker) => string | undefined;
  onSendSticker: (sticker: TelegramSticker) => void;
  onSendGif: (gif: TelegramSticker) => void;
  onSearchGifs: (query: string) => Promise<TelegramSticker[]>;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onExpressionOpenChange: (open: boolean) => void;
}

function AttachmentThumbnail(props: { file: File }) {
  const [preview, setPreview] = createSignal('');
  let previewUrl = '';
  createEffect(() => {
    const file = props.file;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : '';
    setPreview(previewUrl);
  });
  onCleanup(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  });
  return (
    <Show when={preview()} fallback={<FileText size={22} aria-hidden="true" />}>
      {(url) => <img src={url()} alt="" />}
    </Show>
  );
}

export function ChatComposer(props: ChatComposerProps) {
  const [fileInput, setFileInput] = createSignal<HTMLInputElement>();
  const [textarea, setTextarea] = createSignal<HTMLTextAreaElement>();
  const [editingAttachmentId, setEditingAttachmentId] = createSignal('');
  const [expressionOpen, setExpressionOpen] = createSignal(false);
  const [expressionTab, setExpressionTab] = createSignal<ExpressionTab>('emoji');
  const [formatMenu, setFormatMenu] = createSignal<{ x: number; y: number }>();
  let expressionRoot: HTMLDivElement | undefined;
  let expressionButton: HTMLButtonElement | undefined;
  let expressionPointerType = '';

  const editingAttachment = () => props.attachments.find(({ id }) => id === editingAttachmentId());

  const resizeTextarea = () => {
    const input = textarea();
    if (!input) return;
    input.style.height = '0px';
    const style = getComputedStyle(input);
    const minimum = Number.parseFloat(style.minHeight) || 0;
    const maximum = Number.parseFloat(style.maxHeight) || Number.POSITIVE_INFINITY;
    const height = Math.max(minimum, Math.min(input.scrollHeight, maximum));
    input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight > maximum ? 'auto' : 'hidden';
  };

  const closeExpression = (restoreFocus = false) => {
    const focusWasInside = Boolean(
      expressionRoot && document.activeElement && expressionRoot.contains(document.activeElement),
    );
    setExpressionOpen(false);
    if (restoreFocus || focusWasInside) queueMicrotask(() => expressionButton?.focus());
  };

  createEffect(() => {
    void props.conversationId;
    closeExpression();
  });
  createEffect(() => {
    props.onExpressionOpenChange(expressionOpen());
  });
  createEffect(() => {
    void props.draft;
    queueMicrotask(resizeTextarea);
  });
  onMount(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        expressionOpen() &&
        !expressionRoot?.contains(target) &&
        !expressionButton?.contains(target)
      ) {
        closeExpression();
      }
      if (formatMenu() && !(event.target as Element).closest?.('.composer-format-menu')) {
        setFormatMenu(undefined);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (expressionOpen()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeExpression(true);
      } else if (formatMenu()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setFormatMenu(undefined);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    onCleanup(() => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    });
  });
  onCleanup(() => {
    props.onExpressionOpenChange(false);
  });

  const attachTransferredFiles = (files: FileList | null, fallbackName: string) => {
    const sources = [...(files ?? [])];
    if (sources.length === 0) return;
    props.onAttach(
      sources.map((source, index) =>
        source.name
          ? source
          : new File(
              [source],
              sources.length === 1 ? fallbackName : `${fallbackName}-${index + 1}`,
              { type: source.type || 'application/octet-stream' },
            ),
      ),
    );
  };

  const applyFormat = (kind: TelegramTextFormat['kind']) => {
    const input = textarea();
    if (!input) return;
    const offset = input.selectionStart;
    const length = input.selectionEnd - offset;
    if (length <= 0) return;
    const url = kind === 'textUrl' ? window.prompt('Link URL', 'https://')?.trim() : undefined;
    if (kind === 'textUrl' && !url) return;
    props.onFormats([
      ...props.formats.filter(
        (format) => !(format.offset === offset && format.length === length && format.kind === kind),
      ),
      { offset, length, kind, ...(url ? { url } : {}) },
    ]);
    input.focus();
  };

  const insertEmoji = (emoji: string) => {
    const input = textarea();
    const offset = input?.selectionStart ?? props.draft.length;
    props.onDraft(`${props.draft.slice(0, offset)}${emoji}${props.draft.slice(offset)}`);
    props.onFormats([]);
    closeExpression();
    queueMicrotask(() => {
      const nextInput = textarea();
      if (!nextInput) return;
      const nextOffset = offset + emoji.length;
      nextInput.focus();
      nextInput.setSelectionRange(nextOffset, nextOffset);
      resizeTextarea();
    });
  };

  const selectExpressionTab = (tab: ExpressionTab) => {
    setExpressionTab(tab);
    if (tab === 'stickers' && !props.stickerPickerOpen) props.onToggleStickers();
    if (tab === 'gifs' && !props.gifPickerOpen) props.onToggleGifs();
  };

  return (
    <footer class="chat-composer relative shrink-0 border-t border-[var(--line)] bg-[var(--panel)] p-3">
      <Show when={expressionOpen()}>
        <div ref={(element) => (expressionRoot = element)}>
          <ExpressionPicker
            tab={expressionTab()}
            setTab={selectExpressionTab}
            stickersLoading={props.stickerPickerLoading}
            gifsLoading={props.gifPickerLoading}
            gifs={props.gifs}
            packs={props.stickerPacks}
            insertEmoji={insertEmoji}
            load={props.onLoadSticker}
            stickerUrl={props.stickerUrl}
            sendSticker={(sticker) => {
              closeExpression();
              props.onSendSticker(sticker);
            }}
            sendGif={(gif) => {
              closeExpression();
              props.onSendGif(gif);
            }}
            searchGifs={props.onSearchGifs}
          />
        </div>
      </Show>
      <Show when={props.reply}>
        {(reply) => (
          <div class="composer-reply" data-testid="composer-reply">
            <span>
              <strong>{reply().quoteText ? 'Reply with quote' : 'Reply'}</strong>
              <small>{reply().preview}</small>
            </span>
            <button onClick={props.onCancelReply} aria-label="Cancel reply">
              <X size={16} />
            </button>
          </div>
        )}
      </Show>
      <Show when={props.editing}>
        {(editing) => (
          <div class="composer-reply" data-testid="composer-edit">
            <span>
              <strong>Editing message</strong>
              <small>{editing().body || editing().mediaName || 'Media message'}</small>
            </span>
            <button type="button" onClick={props.onCancelEdit} aria-label="Cancel edit">
              <X size={16} />
            </button>
          </div>
        )}
      </Show>
      <Show when={props.attachments.length > 0}>
        <div class="composer-attachments" aria-label="Staged attachments">
          <For each={props.attachments}>
            {(attachment, index) => (
              <div
                class="composer-attachment"
                data-testid="composer-attachment"
                data-attachment-id={attachment.id}
              >
                <AttachmentThumbnail file={attachment.file} />
                <span>
                  <strong>{attachment.file.name}</strong>
                  <small>
                    {index() + 1} of {props.attachments.length} ·{' '}
                    {attachment.file.type || 'application/octet-stream'}
                  </small>
                </span>
                <div
                  class="composer-attachment-mode"
                  role="group"
                  aria-label={`Send ${attachment.file.name} as`}
                >
                  <button
                    type="button"
                    aria-pressed={attachment.sendAs === 'media'}
                    onClick={() => props.onUpdateAttachment(attachment.id, { sendAs: 'media' })}
                  >
                    Media
                  </button>
                  <button
                    type="button"
                    aria-pressed={attachment.sendAs === 'file'}
                    onClick={() => props.onUpdateAttachment(attachment.id, { sendAs: 'file' })}
                  >
                    File
                  </button>
                </div>
                <Show when={canTransformImage(attachment.file)}>
                  <button
                    type="button"
                    class="composer-attachment-edit"
                    onClick={() => setEditingAttachmentId(attachment.id)}
                    aria-label={`Edit image ${attachment.file.name}`}
                  >
                    <Pencil size={15} />
                  </button>
                </Show>
                <button
                  type="button"
                  onClick={() => props.onRemoveAttachment(attachment.id)}
                  aria-label={`Remove attachment ${attachment.file.name}`}
                >
                  <X size={16} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={editingAttachment()}>
        {(attachment) => (
          <ImageAttachmentEditor
            attachment={attachment()}
            close={() => setEditingAttachmentId('')}
            apply={(file) => props.onUpdateAttachment(attachment().id, { file })}
          />
        )}
      </Show>
      <div class="mx-auto flex max-w-3xl items-center gap-2">
        <input
          ref={setFileInput}
          class="sr-only"
          type="file"
          multiple={!props.editing}
          onChange={(event) => {
            const files = event.currentTarget.files;
            if (files?.length) props.onAttach([...files]);
            event.currentTarget.value = '';
          }}
        />
        <div
          class="composer"
          onDragOver={(event) => {
            const transfer = event.dataTransfer;
            if (transfer?.types.includes('Files')) event.preventDefault();
          }}
          onDrop={(event) => {
            const transfer = event.dataTransfer;
            if (!transfer?.files.length) return;
            event.preventDefault();
            attachTransferredFiles(transfer.files, `dropped-file-${Date.now()}`);
          }}
        >
          <button
            ref={(element) => (expressionButton = element)}
            class="composer-icon-button"
            onPointerDown={(event) => {
              expressionPointerType = event.pointerType;
            }}
            onClick={(event) => {
              const open = !expressionOpen();
              setExpressionOpen(open);
              if (open && (event.detail === 0 || expressionPointerType === 'mouse')) {
                queueMicrotask(() =>
                  expressionRoot
                    ?.querySelector<HTMLInputElement>('.expression-search input')
                    ?.focus(),
                );
              }
              expressionPointerType = '';
            }}
            disabled={!props.enabled}
            aria-label="Choose emoji, GIF, or sticker"
            aria-expanded={expressionOpen()}
          >
            <Smile size={20} />
          </button>
          <Show when={formatMenu()}>
            {(position) => (
              <div
                class="composer-format-menu"
                role="menu"
                aria-label="Message formatting"
                style={{ left: `${position().x}px`, top: `${position().y}px` }}
              >
                <For
                  each={
                    [
                      ['bold', 'Bold', Bold],
                      ['italic', 'Italic', Italic],
                      ['underline', 'Underline', Underline],
                      ['strike', 'Strikethrough', Strikethrough],
                      ['code', 'Monospace', Code],
                      ['spoiler', 'Spoiler', EyeOff],
                      ['blockquote', 'Quote', Quote],
                      ['textUrl', 'Create link', Link2],
                    ] as const
                  }
                >
                  {([kind, label, Icon]) => (
                    <button
                      role="menuitem"
                      onClick={() => {
                        applyFormat(kind);
                        setFormatMenu(undefined);
                      }}
                    >
                      <Icon size={15} /> {label}
                    </button>
                  )}
                </For>
              </div>
            )}
          </Show>
          <textarea
            ref={setTextarea}
            rows="1"
            value={props.draft}
            onInput={(event) => {
              props.onDraft(event.currentTarget.value);
              if (props.formats.length > 0) props.onFormats([]);
              resizeTextarea();
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault();
                props.onSend();
              }
            }}
            onPaste={(event) => {
              const clipboard = event.clipboardData;
              if (!clipboard?.files.length) return;
              event.preventDefault();
              attachTransferredFiles(clipboard.files, `pasted-image-${Date.now()}.png`);
            }}
            onContextMenu={(event) => {
              if (event.currentTarget.selectionStart === event.currentTarget.selectionEnd) return;
              event.preventDefault();
              setExpressionOpen(false);
              setFormatMenu({
                x: Math.min(event.clientX, window.innerWidth - 190),
                y: Math.min(event.clientY, window.innerHeight - 310),
              });
            }}
            placeholder={props.placeholder || 'Write a message'}
            aria-label="Message"
          />
          <button
            class="composer-icon-button"
            onClick={() => fileInput()?.click()}
            disabled={!props.enabled}
            aria-label={props.editing ? 'Replace media' : 'Attach files'}
          >
            <Paperclip size={20} />
          </button>
        </div>
        <button
          class="send-button"
          onClick={props.onSend}
          disabled={
            (!props.draft.trim() && props.attachments.length === 0 && !props.editing?.hasMedia) ||
            !props.enabled
          }
          aria-label="Send message"
        >
          <SendHorizontal size={18} />
        </button>
      </div>
    </footer>
  );
}
