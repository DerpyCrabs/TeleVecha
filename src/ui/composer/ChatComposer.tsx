import { list as renderList } from 'effectweb';
import { commandSlot } from 'effectweb';
import { Effect } from 'effect';
import type { TelegramSticker, TelegramTextFormat } from '../../telegram/types';
import { idRows } from '../collections';
import Bold from '@effectweb/lucide/icons/bold';
import Code from '@effectweb/lucide/icons/code';
import EyeOff from '@effectweb/lucide/icons/eye-off';
import FileText from '@effectweb/lucide/icons/file-text';
import Italic from '@effectweb/lucide/icons/italic';
import Link2 from '@effectweb/lucide/icons/link-2';
import Paperclip from '@effectweb/lucide/icons/paperclip';
import Pencil from '@effectweb/lucide/icons/pencil';
import Quote from '@effectweb/lucide/icons/quote';
import SendHorizontal from '@effectweb/lucide/icons/send-horizontal';
import Smile from '@effectweb/lucide/icons/smile';
import Strikethrough from '@effectweb/lucide/icons/strikethrough';
import Underline from '@effectweb/lucide/icons/underline';
import X from '@effectweb/lucide/icons/x';
import type { Command } from 'effectweb';
import { component, domBinding, sequence, view, actionCommand, patchModel } from 'effectweb';
import type { Send } from 'effectweb/program';
import type { ComposerSession } from './composerSession';
import type { ExpressionTab } from './ExpressionPicker';
import { ExpressionPicker } from './ExpressionPicker';
import type { ExpressionSession } from './expressionSession';
import { ImageAttachmentEditor } from './ImageAttachmentEditor';
import { canTransformImage } from './outgoingAttachments';
import { fileImageMount } from '../shared/fileImageMount';
const commandExpressionVisibility = commandSlot('expression-visibility');
const commandFocus = commandSlot('focus');
const commandFormat = commandSlot('format');
const commandInsert = commandSlot('insert');

interface ChatComposerProps {
  conversationId: string;
  enabled: boolean;
  canSendMedia: boolean;
  canSendStickers: boolean;
  canSendGifs: boolean;
  placeholder?: string | undefined;
  composer: ComposerSession;
  expressions: ExpressionSession;
  editLastMessage?: (() => boolean) | undefined;
  onGeometryChange?: (() => void) | undefined;
  media: {
    loadSticker(sticker: TelegramSticker): Effect.Effect<string, unknown>;
    stickerUrl(sticker: TelegramSticker): string | undefined;
  };
}
const AttachmentThumbnail = view<{ file: File }, never>((props, _send) =>
  props.file.type.startsWith('image/') ? (
    <img draggable={false} use={fileImageMount(props.file)} alt="" />
  ) : (
    <FileText size={22} aria-hidden="true" />
  ),
);
type ChatComposerModel = {
  element: HTMLElement | undefined;
  props: ChatComposerProps;
  editingAttachmentId: string;
  expressionOpen: boolean;
  expressionTab: ExpressionTab;
  formatMenu: { x: number; y: number } | undefined;
  expressionPointerType: string;
};
type ChatComposerMessage =
  | { type: 'Mounted'; element: HTMLElement }
  | { type: 'Dismiss'; restoreFocus: boolean }
  | { type: 'ApplyFormat'; kind: TelegramTextFormat['kind'] }
  | { type: 'InsertEmoji'; emoji: string }
  | { type: 'FocusExpressions' }
  | { type: 'ExpressionOpenState'; value: boolean }
  | {
      type: 'Fields';
      fields: Partial<
        Pick<
          ChatComposerModel,
          'editingAttachmentId' | 'expressionTab' | 'formatMenu' | 'expressionPointerType'
        >
      >;
    };
const FormattingIcon = view<{ kind: TelegramTextFormat['kind'] }, never>((props, _send) =>
  props.kind === 'bold' ? (
    <Bold size={15} />
  ) : props.kind === 'italic' ? (
    <Italic size={15} />
  ) : props.kind === 'underline' ? (
    <Underline size={15} />
  ) : props.kind === 'strike' ? (
    <Strikethrough size={15} />
  ) : props.kind === 'code' ? (
    <Code size={15} />
  ) : props.kind === 'spoiler' ? (
    <EyeOff size={15} />
  ) : props.kind === 'blockquote' ? (
    <Quote size={15} />
  ) : (
    <Link2 size={15} />
  ),
);
function pickFiles(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
  event.currentTarget
    .closest('footer')
    ?.querySelector<HTMLInputElement>('input[type="file"]')
    ?.click();
}
function clearFileControl(element: HTMLInputElement) {
  element.value = '';
}
function transferName(stem: string) {
  return `${stem}-${Date.now()}`;
}
function formatMenuPosition(x: number, y: number) {
  return { x: Math.min(x, window.innerWidth - 190), y: Math.min(y, window.innerHeight - 310) };
}
function visibilityCommand(props: ChatComposerProps, open: boolean): Command<ChatComposerMessage> {
  return actionCommand(
    commandExpressionVisibility,
    () =>
      Effect.sync(() => {
        props.expressions.setVisible(open);
      }),
    'replace',
  );
}
function formatSelection(model: ChatComposerModel, kind: TelegramTextFormat['kind']) {
  const input = model.element?.querySelector('textarea');
  if (!input) return;
  const offset = input.selectionStart,
    length = input.selectionEnd - offset;
  if (length <= 0) return;
  const url = kind === 'textUrl' ? window.prompt('Link URL', 'https://')?.trim() : undefined;
  if (kind === 'textUrl' && !url) return;
  model.props.composer.setFormats([
    ...model.props.composer.formats.filter(
      (format) => !(format.offset === offset && format.length === length && format.kind === kind),
    ),
    { offset, length, kind, ...(url ? { url } : {}) },
  ]);
  input.focus();
}
function insertAtSelection(model: ChatComposerModel, emoji: string) {
  if (!model.props.enabled) return;
  const input = model.element?.querySelector('textarea'),
    draft = model.props.composer.draft,
    offset = input?.selectionStart ?? draft.length;
  model.props.composer.changeDraft(`${draft.slice(0, offset)}${emoji}${draft.slice(offset)}`);
  model.props.composer.setFormats([]);
  queueMicrotask(() => {
    if (!input?.isConnected) return;
    input.focus();
    input.setSelectionRange(offset + emoji.length, offset + emoji.length);
  });
}
function acquireComposer(element: HTMLElement, input: () => Send<ChatComposerMessage>) {
  const send = input();
  send({ type: 'Mounted', element });
  const popup = () => element.querySelector<HTMLElement>('.expression-popup-host');
  const trigger = () =>
    element.querySelector<HTMLElement>('[aria-label="Choose emoji, GIF, or sticker"]');
  const dismiss = (event: PointerEvent) => {
    const target = event.target as Element,
      root = popup();
    if (root && !root.contains(target) && !trigger()?.contains(target))
      send({
        type: 'Dismiss',
        restoreFocus: Boolean(document.activeElement && root.contains(document.activeElement)),
      });
    else if (!target.closest?.('.composer-format-menu'))
      send({ type: 'Fields', fields: { formatMenu: undefined } });
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (popup()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send({ type: 'Dismiss', restoreFocus: true });
    } else if (element.querySelector('.composer-format-menu')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send({ type: 'Fields', fields: { formatMenu: undefined } });
    }
  };
  document.addEventListener('pointerdown', dismiss);
  document.addEventListener('keydown', escape);
  return () => {
    document.removeEventListener('pointerdown', dismiss);
    document.removeEventListener('keydown', escape);
  };
}
const composerMount = (send: Send<ChatComposerMessage>) => domBinding(send, acquireComposer);
export const ChatComposer = component<ChatComposerProps, ChatComposerModel, ChatComposerMessage>({
  init: (props) => ({
    props,
    element: undefined,
    editingAttachmentId: '',
    expressionOpen: false,
    expressionTab: 'emoji',
    formatMenu: undefined,
    expressionPointerType: '',
  }),
  receive: (model, props) => {
    const reset = props.conversationId !== model.props.conversationId;
    const close = reset || !props.enabled;
    const next = {
      ...model,
      props,
      ...(reset
        ? { editingAttachmentId: '', formatMenu: undefined, expressionTab: 'emoji' as const }
        : {}),
      ...(close ? { expressionOpen: false } : {}),
    };
    return close && model.expressionOpen
      ? { model: next, commands: [visibilityCommand(props, false)] }
      : { model: next };
  },
  update: (model, message) => {
    switch (message.type) {
      case 'Mounted':
        return { model: { ...model, element: message.element } };
      case 'Dismiss':
        return {
          model: { ...model, expressionOpen: false, formatMenu: undefined },
          commands: [
            visibilityCommand(model.props, false),
            actionCommand(
              commandFocus,
              () =>
                Effect.sync(() => {
                  if (message.restoreFocus)
                    model.element
                      ?.querySelector<HTMLButtonElement>(
                        '[aria-label="Choose emoji, GIF, or sticker"]',
                      )
                      ?.focus();
                }),
              'replace',
            ),
          ],
        };
      case 'FocusExpressions':
        return {
          model,
          commands: [
            actionCommand(
              commandFocus,
              () =>
                Effect.sync(() => {
                  queueMicrotask(() =>
                    model.element
                      ?.querySelector<HTMLInputElement>('.expression-search input')
                      ?.focus(),
                  );
                }),
              'replace',
            ),
          ],
        };
      case 'ApplyFormat':
        return {
          model,
          commands: [
            actionCommand(
              commandFormat,
              () =>
                Effect.sync(() => {
                  formatSelection(model, message.kind);
                }),
              'replace',
            ),
          ],
        };
      case 'InsertEmoji':
        return {
          model: { ...model, expressionOpen: false },
          commands: [
            visibilityCommand(model.props, false),
            actionCommand(
              commandInsert,
              () =>
                Effect.sync(() => {
                  insertAtSelection(model, message.emoji);
                }),
              'replace',
            ),
          ],
        };
      case 'ExpressionOpenState':
        return {
          model: { ...model, expressionOpen: message.value },
          commands: [visibilityCommand(model.props, message.value)],
        };
      case 'Fields':
        return { model: patchModel(model, message.fields) };
    }
  },
  view: view((model, send) => {
    const props = model.props;
    const setExpressionOpen = (open: boolean) => send({ type: 'ExpressionOpenState', value: open });
    const editingAttachment = () =>
      props.composer.attachments.find(({ id }) => id === model.editingAttachmentId);
    const hasImageBatch = () => {
      const attachments = props.composer.attachments;
      return (
        attachments.length > 1 && attachments.every(({ file }) => file.type.startsWith('image/'))
      );
    };
    const setAllAttachmentModes = (sendAs: 'media' | 'file') => {
      for (const attachment of props.composer.attachments) {
        props.composer.updateAttachment(attachment.id, { sendAs });
      }
    };
    const removeAllAttachments = () => {
      for (const attachment of props.composer.attachments) {
        props.composer.removeAttachment(attachment.id);
      }
    };
    const closeExpression = () => send({ type: 'ExpressionOpenState', value: false });
    const attachTransferredFiles = (files: FileList | null, fallbackName: string) => {
      if (!props.canSendMedia) return;
      const sources = [...(files ?? [])];
      if (sources.length === 0) return;
      props.composer.attach(
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
    const applyFormat = (kind: TelegramTextFormat['kind']) => send({ type: 'ApplyFormat', kind });
    const insertEmoji = (emoji: string) => send({ type: 'InsertEmoji', emoji });
    const selectExpressionTab = (tab: ExpressionTab) => {
      if (tab === 'stickers' && !props.canSendStickers) return;
      if (tab === 'gifs' && !props.canSendGifs) return;
      send({ type: 'Fields', fields: { expressionTab: tab } });
      if (tab === 'stickers' && !props.expressions.stickerOpen) {
        props.expressions.toggleStickers();
      }
      if (tab === 'gifs' && !props.expressions.gifOpen) props.expressions.toggleGifs();
    };
    return (
      <footer
        use={composerMount(send)}
        class="chat-composer relative shrink-0 border-t border-line bg-panel p-3"
      >
        {model.expressionOpen ? (
          <div class="expression-popup-host">
            <ExpressionPicker
              tab={model.expressionTab}
              setTab={selectExpressionTab}
              stickersLoading={props.expressions.stickerLoading}
              gifsLoading={props.expressions.gifLoading}
              gifError={props.expressions.gifError}
              gifs={props.expressions.gifs}
              packs={props.expressions.stickerPacks}
              insertEmoji={insertEmoji}
              canSend={props.enabled}
              canSendGifs={props.canSendGifs}
              canSendStickers={props.canSendStickers}
              load={(sticker) => props.media.loadSticker(sticker)}
              stickerUrl={(sticker) => props.media.stickerUrl(sticker)}
              sendSticker={(sticker) => {
                if (!props.canSendStickers) return;
                closeExpression();
                void props.expressions.sendSticker(sticker).catch(() => undefined);
              }}
              sendGif={(gif) => {
                if (!props.canSendGifs) return;
                closeExpression();
                void props.expressions.sendGif(gif).catch(() => undefined);
              }}
              searchGifs={props.expressions.searchGifs}
              retryGifs={props.expressions.retryGifs}
            />
          </div>
        ) : null}
        {props.composer.reply
          ? ((reply) => (
              <div class="composer-reply" data-testid="composer-reply">
                <span>
                  <strong>{reply.quoteText ? 'Reply with quote' : 'Reply'}</strong>
                  <small>{reply.preview}</small>
                </span>
                <button onClick={props.composer.clearReply} aria-label="Cancel reply">
                  <X size={16} />
                </button>
              </div>
            ))(props.composer.reply!)
          : null}
        {props.composer.editing
          ? ((editing) => (
              <div class="composer-reply" data-testid="composer-edit">
                <span>
                  <strong>Editing message</strong>
                  <small>{editing.body || editing.media?.name || 'Media message'}</small>
                </span>
                <button type="button" onClick={props.composer.cancelEdit} aria-label="Cancel edit">
                  <X size={16} />
                </button>
              </div>
            ))(props.composer.editing!)
          : null}
        {props.composer.attachments.length > 0 ? (
          <div
            class="composer-attachments"
            classList={{ 'composer-image-batch': hasImageBatch() }}
            aria-label="Staged attachments"
          >
            {hasImageBatch() ? (
              <div class="composer-attachment-batch-bar">
                <strong>{props.composer.attachments.length} images</strong>
                <div class="composer-attachment-batch-mode" role="group" aria-label="Send all as">
                  <button
                    type="button"
                    aria-pressed={props.composer.attachments.every(
                      ({ sendAs }) => sendAs === 'media',
                    )}
                    onClick={() => setAllAttachmentModes('media')}
                  >
                    Media
                  </button>
                  <button
                    type="button"
                    aria-pressed={props.composer.attachments.every(
                      ({ sendAs }) => sendAs === 'file',
                    )}
                    onClick={() => setAllAttachmentModes('file')}
                  >
                    Files
                  </button>
                </div>
                <button type="button" onClick={pickFiles}>
                  Add
                </button>
                <button type="button" onClick={removeAllAttachments}>
                  Clear
                </button>
              </div>
            ) : null}
            {renderList(idRows(props.composer.attachments), (attachment, index) => (
              <div
                class="composer-attachment"
                data-testid="composer-attachment"
                data-attachment-id={attachment.id}
              >
                <div class="composer-attachment-preview">
                  <AttachmentThumbnail file={attachment.file} />
                </div>
                <span>
                  <strong>{attachment.file.name}</strong>
                  <small>
                    {index + 1} of {props.composer.attachments.length} ·{' '}
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
                    onClick={() =>
                      props.composer.updateAttachment(attachment.id, { sendAs: 'media' })
                    }
                  >
                    Media
                  </button>
                  <button
                    type="button"
                    aria-pressed={attachment.sendAs === 'file'}
                    onClick={() =>
                      props.composer.updateAttachment(attachment.id, { sendAs: 'file' })
                    }
                  >
                    File
                  </button>
                </div>
                {canTransformImage(attachment.file) ? (
                  <button
                    type="button"
                    class="composer-attachment-edit"
                    onClick={() =>
                      send({ type: 'Fields', fields: { editingAttachmentId: attachment.id } })
                    }
                    aria-label={`Edit image ${attachment.file.name}`}
                  >
                    <Pencil size={15} />
                  </button>
                ) : null}
                <button
                  type="button"
                  class="composer-attachment-remove"
                  onClick={() => props.composer.removeAttachment(attachment.id)}
                  aria-label={`Remove attachment ${attachment.file.name}`}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {editingAttachment()
          ? ((attachment) => (
              <ImageAttachmentEditor
                attachment={attachment}
                close={() => send({ type: 'Fields', fields: { editingAttachmentId: '' } })}
                apply={(file) => props.composer.updateAttachment(attachment.id, { file })}
              />
            ))(editingAttachment()!)
          : null}
        <div class="mx-auto flex w-full min-w-0 max-w-3xl items-center gap-2">
          <input
            class="sr-only"
            type="file"
            multiple={!props.composer.editing}
            disabled={!props.canSendMedia}
            onChange={(event) => {
              const files = event.currentTarget.files;
              if (props.canSendMedia && files?.length) props.composer.attach([...files]);
              clearFileControl(event.currentTarget);
            }}
          />
          <div
            class="composer"
            onDragOver={(event) => {
              const transfer = event.dataTransfer;
              if (transfer?.types.includes('Files')) event.preventDefault();
            }}
            onDrop={(event) => {
              if (!props.canSendMedia) return;
              const transfer = event.dataTransfer;
              if (!transfer?.files.length) return;
              event.preventDefault();
              attachTransferredFiles(transfer.files, transferName('dropped-file'));
            }}
          >
            <button
              class="composer-icon-button"
              onPointerDown={(event) => {
                send({ type: 'Fields', fields: { expressionPointerType: event.pointerType } });
              }}
              onClick={(event) => {
                const open = !model.expressionOpen;
                setExpressionOpen(open);
                if (open && (event.detail === 0 || model.expressionPointerType === 'mouse'))
                  send({ type: 'FocusExpressions' });
                send({ type: 'Fields', fields: { expressionPointerType: '' } });
              }}
              disabled={!props.enabled}
              aria-label="Choose emoji, GIF, or sticker"
              aria-expanded={model.expressionOpen}
            >
              <Smile size={20} />
            </button>
            {model.formatMenu
              ? ((position) => (
                  <div
                    class="composer-format-menu"
                    role="menu"
                    aria-label="Message formatting"
                    style={{ left: `${position.x}px`, top: `${position.y}px` }}
                  >
                    {renderList(
                      sequence([
                        ['bold', 'Bold'],
                        ['italic', 'Italic'],
                        ['underline', 'Underline'],
                        ['strike', 'Strikethrough'],
                        ['code', 'Monospace'],
                        ['spoiler', 'Spoiler'],
                        ['blockquote', 'Quote'],
                        ['textUrl', 'Create link'],
                      ] as const),
                      (_item) => {
                        const [kind, label] = _item;
                        return (
                          <button
                            role="menuitem"
                            onClick={() => {
                              applyFormat(kind);
                              send({ type: 'Fields', fields: { formatMenu: undefined } });
                            }}
                          >
                            <FormattingIcon kind={kind} /> {label}
                          </button>
                        );
                      },
                    )}
                  </div>
                ))(model.formatMenu!)
              : null}
            <textarea
              rows="1"
              value={props.composer.draft}
              onInput={(event) => {
                props.composer.changeDraft(event.currentTarget.value);
                if (props.composer.formats.length > 0) props.composer.setFormats([]);
                void event.currentTarget.offsetHeight;
                props.onGeometryChange?.();
              }}
              onKeyDown={(event) => {
                if (!props.enabled) {
                  event.preventDefault();
                  return;
                }
                if (event.key === 'Escape' && props.composer.editing) {
                  event.preventDefault();
                  event.stopPropagation();
                  props.composer.cancelEdit();
                  return;
                }
                if (event.key === 'Escape' && props.composer.reply) {
                  event.preventDefault();
                  event.stopPropagation();
                  props.composer.clearReply();
                  props.composer.focus();
                  return;
                }
                if (
                  event.key === 'ArrowUp' &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey &&
                  !event.isComposing &&
                  event.keyCode !== 229 &&
                  props.composer.draft.length === 0 &&
                  props.composer.attachments.length === 0 &&
                  !props.composer.reply &&
                  !props.composer.editing &&
                  props.editLastMessage?.()
                ) {
                  event.preventDefault();
                  return;
                }
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  props.composer.send();
                }
              }}
              onPaste={(event) => {
                if (!props.canSendMedia) return;
                const clipboard = event.clipboardData;
                if (!clipboard?.files.length) return;
                event.preventDefault();
                attachTransferredFiles(clipboard.files, `${transferName('pasted-image')}.png`);
              }}
              onContextMenu={(event) => {
                if (!props.enabled) return;
                if (event.currentTarget.selectionStart === event.currentTarget.selectionEnd) return;
                event.preventDefault();
                setExpressionOpen(false);
                send({
                  type: 'Fields',
                  fields: { formatMenu: { ...formatMenuPosition(event.clientX, event.clientY) } },
                });
              }}
              placeholder={props.placeholder || 'Write a message'}
              aria-label="Message"
              readOnly={!props.enabled}
            />
            <button
              class="composer-icon-button"
              onClick={pickFiles}
              disabled={!props.canSendMedia}
              aria-label={props.composer.editing ? 'Replace media' : 'Attach files'}
            >
              <Paperclip size={20} />
            </button>
          </div>
          <button
            class="send-button"
            onClick={() => props.composer.send()}
            disabled={
              (!props.composer.draft.trim() &&
                props.composer.attachments.length === 0 &&
                !props.composer.editing?.media) ||
              !props.enabled
            }
            aria-label="Send message"
          >
            <SendHorizontal size={18} />
          </button>
        </div>
      </footer>
    );
  }),
});
