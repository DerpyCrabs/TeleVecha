import { findMention, filterMentionMembers, shiftFormats } from './mentions';
import { patchModel } from 'effectweb/advanced';
import type { TelegramGroupMember } from '../../telegram/types';
import { list, commandSlot, component, domBinding, sequence, view, actionCommand } from 'effectweb';
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
import type { Send } from 'effectweb';
import type { ComposerSession } from './composerSession';
import type { ExpressionTab } from './ExpressionPicker';
import { ExpressionPicker } from './ExpressionPicker';
import type { ExpressionSession } from './expressionSession';
import { ImageAttachmentEditor } from './ImageAttachmentEditor';
import { canTransformImage } from './outgoingAttachments';
import { fileImageMount } from '../shared/fileImageMount';
import { formatMediaSize } from '../media/mediaPresentation';
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
function acquireVideoThumbnail(element: HTMLVideoElement, input: () => File) {
  let file = input();
  let url = URL.createObjectURL(file);
  element.src = url;
  return {
    update() {
      const next = input();
      if (next === file) return;
      const previous = url;
      url = URL.createObjectURL(next);
      file = next;
      element.src = url;
      URL.revokeObjectURL(previous);
    },
    dispose() {
      element.removeAttribute('src');
      element.load();
      URL.revokeObjectURL(url);
    },
  };
}

const AttachmentThumbnail = view<{ file: File }, never>((props, _send) =>
  props.file.type.startsWith('image/') ? (
    <img draggable={false} use={fileImageMount(props.file)} alt="" />
  ) : props.file.type.startsWith('video/') ? (
    <video
      use={domBinding(props.file, acquireVideoThumbnail)}
      preload="auto"
      controls
      playsInline
      aria-label={`Video preview: ${props.file.name}`}
    />
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
  mention: ReturnType<typeof findMention>;
  mentionIndex: number;
};
type ChatComposerMessage =
  | { type: 'MentionChanged'; mention: ReturnType<typeof findMention> }
  | { type: 'SelectMention'; member: TelegramGroupMember }
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
          | 'editingAttachmentId'
          | 'expressionTab'
          | 'formatMenu'
          | 'expressionPointerType'
          | 'mention'
          | 'mentionIndex'
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
    mention: undefined,
    mentionIndex: 0,
  }),
  receive: (model, props) => {
    const reset = props.conversationId !== model.props.conversationId;
    const close = reset || !props.enabled;
    const currentMention = model.mention && findMention(props.composer.draft, model.mention.end);
    const dismissMention =
      close ||
      (model.mention &&
        (currentMention?.offset !== model.mention.offset ||
          currentMention?.query !== model.mention.query));
    const next = {
      ...model,
      props,
      ...(reset
        ? { editingAttachmentId: '', formatMenu: undefined, expressionTab: 'emoji' as const }
        : {}),
      ...(close ? { expressionOpen: false } : {}),
      ...(dismissMention ? { mention: undefined, mentionIndex: 0 } : {}),
    };
    return close && model.expressionOpen
      ? { model: next, commands: [visibilityCommand(props, false)] }
      : { model: next };
  },
  update: (model, message) => {
    switch (message.type) {
      case 'MentionChanged': {
        const unchanged =
          model.mention?.offset === message.mention?.offset &&
          model.mention?.end === message.mention?.end &&
          model.mention?.query === message.mention?.query;
        return {
          model: {
            ...model,
            mention: message.mention,
            mentionIndex: unchanged ? model.mentionIndex : 0,
          },
        };
      }
      case 'SelectMention': {
        const mention = model.mention;
        if (!mention || !model.props.enabled) return { model };
        return {
          model: { ...model, mention: undefined, mentionIndex: 0 },
          commands: [
            actionCommand(
              commandInsert,
              () =>
                Effect.sync(() => {
                  const composer = model.props.composer;
                  const member = message.member;
                  const text = member.username
                    ? `@${member.username}`
                    : member.firstName || member.title;
                  const draft =
                    composer.draft.slice(0, mention.offset) +
                    text +
                    ' ' +
                    composer.draft.slice(mention.end);
                  const formats = shiftFormats(composer.formats, composer.draft, draft);
                  composer.changeDraft(draft);
                  composer.setFormats([
                    ...formats,
                    {
                      offset: mention.offset,
                      length: text.length,
                      kind: member.username ? 'mention' : 'mentionName',
                      userId: member.peer.id,
                      accessHash: member.peer.accessHash,
                    },
                  ]);
                  queueMicrotask(() => {
                    const input = model.element?.querySelector('textarea');
                    input?.focus();
                    input?.setSelectionRange(
                      mention.offset + text.length + 1,
                      mention.offset + text.length + 1,
                    );
                  });
                }),
              'replace',
            ),
          ],
        };
      }
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
    const mentionMembers = () =>
      model.mention ? filterMentionMembers(props.composer.mentionMembers, model.mention.query) : [];
    const updateMention = (input: HTMLTextAreaElement) => {
      const mention = props.enabled
        ? findMention(input.value, input.selectionStart, input.selectionEnd)
        : undefined;
      const blocked =
        mention &&
        props.composer.formats.some(
          (format) =>
            ['code', 'pre', 'textUrl', 'mention', 'mentionName'].includes(format.kind) &&
            mention.offset >= format.offset &&
            mention.offset < format.offset + format.length,
        );
      send({ type: 'MentionChanged', mention: blocked ? undefined : mention });
      if (mention && !blocked) props.composer.loadMentionMembers();
    };
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
              gifSearch={
                props.expressions.gifPeer
                  ? (text) => props.expressions.gifSearch(props.expressions.gifPeer!, text)
                  : undefined
              }
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
            {list(idRows(props.composer.attachments), (attachment) => (
              <div
                class="composer-attachment"
                data-testid="composer-attachment"
                data-attachment-id={attachment.id}
              >
                <div class="composer-attachment-preview">
                  <AttachmentThumbnail file={attachment.file} />
                </div>
                <span>
                  <strong title={attachment.file.name}>{attachment.file.name}</strong>
                  <small>{formatMediaSize(attachment.file.size) || '0 B'}</small>
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
            {model.mention && mentionMembers().length > 0 ? (
              <div
                class="composer-mentions"
                id="composer-mentions"
                role="listbox"
                aria-label="Mention a member"
              >
                {list(
                  idRows(mentionMembers().map((member) => ({ ...member, id: member.peer.id }))),
                  (member) => (
                    <button
                      type="button"
                      role="option"
                      id={`mention-${member.peer.id}`}
                      aria-selected={
                        mentionMembers()[model.mentionIndex]?.peer.id === member.peer.id
                      }
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => send({ type: 'SelectMention', member })}
                    >
                      <span class="composer-mention-avatar" style={{ background: member.color }}>
                        {member.initials}
                      </span>
                      <span class="composer-mention-name">
                        <strong>{member.title}</strong>
                        {member.username ? <small>@{member.username}</small> : null}
                      </span>
                    </button>
                  ),
                )}
              </div>
            ) : null}
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
                    {list(
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
                updateMention(event.currentTarget);
                void event.currentTarget.offsetHeight;
                props.onGeometryChange?.();
              }}
              aria-autocomplete="list"
              aria-expanded={Boolean(model.mention && mentionMembers().length)}
              aria-controls="composer-mentions"
              aria-activedescendant={
                model.mention && mentionMembers()[model.mentionIndex]
                  ? `mention-${mentionMembers()[model.mentionIndex]!.peer.id}`
                  : undefined
              }
              onSelect={(event) => updateMention(event.currentTarget)}
              onClick={(event) => updateMention(event.currentTarget)}
              onKeyUp={(event) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
                  updateMention(event.currentTarget);
              }}
              onBlur={() => send({ type: 'Fields', fields: { mention: undefined } })}
              onKeyDown={(event) => {
                if (event.isComposing || event.keyCode === 229) return;
                const members = mentionMembers();
                if (
                  model.mention &&
                  members.length > 0 &&
                  !event.shiftKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.altKey
                ) {
                  if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.key === 'Escape')
                      send({ type: 'Fields', fields: { mention: undefined } });
                    else if (event.key === 'Enter' || event.key === 'Tab')
                      send({
                        type: 'SelectMention',
                        member: members[model.mentionIndex] ?? members[0]!,
                      });
                    else {
                      const index =
                        (model.mentionIndex + (event.key === 'ArrowUp' ? -1 : 1) + members.length) %
                        members.length;
                      send({ type: 'Fields', fields: { mentionIndex: index } });
                      model.element
                        ?.querySelectorAll('.composer-mentions button')
                        [index]?.scrollIntoView({ block: 'nearest' });
                    }
                    return;
                  }
                }
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
