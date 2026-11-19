import { PointMenu, ToggleMenu, menuAtPoint } from '../shared/menuSurface';
import { BotControls, type BotControlsProps } from '../bots/BotControls';
import { BotKeyboard } from '../bots/BotKeyboard';
import Keyboard from '@effectweb/lucide/icons/keyboard';
import type { TelegramBotKeyboard, TelegramBotButton } from '../../telegram/types';
import { ForwardDraft, type ForwardDraftProps } from './ForwardDraft';
import { modalVisible } from '../shared/focusScope';
import Image from '@effectweb/lucide/icons/image';
import ChartNoAxesColumn from '@effectweb/lucide/icons/chart-no-axes-column';
import { PollCreateDialog } from './PollCreateDialog';
import type { TelegramPollDraft } from '../../telegram/types';
import { findMention, filterMentionMembers, shiftFormats } from './mentions';
import { patchModel } from '../shared/composition';
import type { TelegramGroupMember } from '../../telegram/types';
import { list, component, domBinding, sequence, view } from 'effectweb';
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
import { AttachmentSendDialog } from './AttachmentSendDialog';
const commandExpressionVisibility = 'expression-visibility';
const commandFocus = 'focus';
const commandFormat = 'format';
const commandInsert = 'insert';

interface ChatComposerProps {
  botControls?: BotControlsProps | undefined;
  replyKeyboard?: TelegramBotKeyboard | undefined;
  replyKeyboardAvailable?: boolean;
  toggleReplyKeyboard?: () => void;
  replyKeyboardBusy?: string | undefined;
  onReplyButton?: (button: TelegramBotButton, key: string) => void;
  forwardDraft?: (ForwardDraftProps & { send: () => void }) | undefined;
  conversationId: string;
  enabled: boolean;
  canSendMedia: boolean;
  canSendPolls?: boolean;
  sendPoll?: (draft: TelegramPollDraft) => Effect.Effect<unknown, unknown>;
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
type ChatComposerState = {
  element: HTMLElement | undefined;
  expressionOpen: boolean;
  attachmentMenuOpen: boolean;
  pollOpen: boolean;
  expressionTab: ExpressionTab;
  formatMenu: { x: number; y: number } | undefined;
  expressionPointerType: string;
  mention: ReturnType<typeof findMention>;
  mentionIndex: number;
  dismissedCommandDraft: string | undefined;
};
type ChatComposerModel = ChatComposerState & { readonly props: ChatComposerProps };
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
          | 'attachmentMenuOpen'
          | 'pollOpen'
          | 'expressionTab'
          | 'formatMenu'
          | 'expressionPointerType'
          | 'mention'
          | 'dismissedCommandDraft'
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
function pickFiles(
  event: MouseEvent & { currentTarget: HTMLButtonElement },
  mode?: 'media' | 'file',
) {
  const input = event.currentTarget
    .closest('footer')
    ?.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) return;
  input.accept = mode === 'media' ? 'image/*,video/*' : '';
  input.dataset.sendAs = mode ?? '';
  input.click();
}
function clearFileControl(element: HTMLInputElement) {
  element.value = '';
}
function transferName(stem: string) {
  return `${stem}-${Date.now()}`;
}
function visibilityCommand(props: ChatComposerProps, open: boolean): Command<ChatComposerMessage> {
  return {
    key: commandExpressionVisibility,
    policy: 'replace',
    effect: Effect.sync(() => {
      props.expressions.setVisible(open);
    }),
  };
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
  const popup = () => element.querySelector<HTMLElement>('.expression-popup-host:not([inert])');
  const trigger = () =>
    element.querySelector<HTMLElement>('[aria-label="Choose emoji, GIF, or sticker"]');
  const dismiss = (event: PointerEvent) => {
    if (modalVisible()) return;
    const target = event.target as Element,
      root = popup();
    if (!target.closest?.('.composer-attach-area'))
      send({ type: 'Fields', fields: { attachmentMenuOpen: false } });
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
    send({ type: 'Fields', fields: { attachmentMenuOpen: false } });
    if (popup()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send({ type: 'Dismiss', restoreFocus: true });
    } else if (element.querySelector('.composer-format-menu:not([inert])')) {
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
const composerMount = (send: Send<ChatComposerMessage>) =>
  domBinding(send, acquireComposer, { identity: send });
export const ChatComposer = component<ChatComposerProps, ChatComposerState, ChatComposerMessage>(
  {
    init: () => ({
      element: undefined,
      attachmentMenuOpen: false,
      pollOpen: false,
      expressionOpen: false,
      expressionTab: 'emoji',
      formatMenu: undefined,
      expressionPointerType: '',
      mention: undefined,
      mentionIndex: 0,
      dismissedCommandDraft: undefined,
    }),
    receive: (model, previous) => {
      const reset = model.props.conversationId !== previous.conversationId;
      const close = reset || !model.props.enabled;
      const currentMention =
        model.mention && findMention(model.props.composer.draft, model.mention.end);
      const dismissMention =
        close ||
        (model.mention &&
          (currentMention?.offset !== model.mention.offset ||
            currentMention?.query !== model.mention.query));
      const next = {
        ...model,
        ...(reset
          ? {
              attachmentMenuOpen: false,
              pollOpen: false,
              formatMenu: undefined,
              expressionTab: 'emoji' as const,
            }
          : {}),
        ...(close ? { expressionOpen: false } : {}),
        ...(dismissMention ? { mention: undefined, mentionIndex: 0 } : {}),
      };
      return close && model.expressionOpen
        ? { model: next, commands: [visibilityCommand(model.props, false)] }
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
              {
                key: commandInsert,
                policy: 'replace',
                effect: Effect.sync(() => {
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
              },
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
              {
                key: commandFocus,
                policy: 'replace',
                effect: Effect.sync(() => {
                  if (message.restoreFocus)
                    model.element
                      ?.querySelector<HTMLButtonElement>(
                        '[aria-label="Choose emoji, GIF, or sticker"]',
                      )
                      ?.focus();
                }),
              },
            ],
          };
        case 'FocusExpressions':
          return {
            model,
            commands: [
              {
                key: commandFocus,
                policy: 'replace',
                effect: Effect.sync(() => {
                  queueMicrotask(() =>
                    model.element
                      ?.querySelector<HTMLInputElement>('.expression-search input')
                      ?.focus(),
                  );
                }),
              },
            ],
          };
        case 'ApplyFormat':
          return {
            model,
            commands: [
              {
                key: commandFormat,
                policy: 'replace',
                effect: Effect.sync(() => {
                  formatSelection(model, message.kind);
                }),
              },
            ],
          };
        case 'InsertEmoji':
          return {
            model: { ...model, expressionOpen: false },
            commands: [
              visibilityCommand(model.props, false),
              {
                key: commandInsert,
                policy: 'replace',
                effect: Effect.sync(() => {
                  insertAtSelection(model, message.emoji);
                }),
              },
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
  },
  view((model, send) => {
    const props = model.props;
    const commandQuery = () =>
      props.botControls &&
      !props.composer.editing &&
      !props.composer.attachments.length &&
      /^\/[A-Za-z0-9_@]*$/.test(props.composer.draft) &&
      model.dismissedCommandDraft !== props.composer.draft
        ? props.composer.draft
        : undefined;
    const closeCommands = () => {
      props.botControls?.onCloseMenu();
      send({ type: 'Fields', fields: { dismissedCommandDraft: props.composer.draft } });
    };
    const commandControls = () =>
      props.botControls
        ? {
            ...props.botControls,
            query: commandQuery(),
            menuOpen: props.botControls.menuOpen || Boolean(commandQuery()),
            onCloseMenu: closeCommands,
            onCommand: (command: import('../../telegram/types').TelegramBotCommand) => {
              if (commandQuery()) props.composer.changeDraft('');
              props.botControls?.onCommand(command);
            },
          }
        : undefined;

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
        <ToggleMenu
          value={model.expressionOpen || undefined}
          render={(_, closing) => (
            <div class="expression-popup-host" inert={closing} aria-hidden={closing || undefined}>
              <ExpressionPicker
                tab={model.expressionTab}
                packActions={props.expressions}
                stickerSearch={props.expressions.stickerSearch}
                setTab={selectExpressionTab}
                stickersLoading={props.expressions.stickerLoading}
                stickerError={props.expressions.stickerError}
                retryStickers={props.expressions.retryStickers}
                setStickerFavorite={props.expressions.setStickerFavorite}
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
          )}
        />
        {props.forwardDraft ? <ForwardDraft {...props.forwardDraft} /> : null}
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
          <AttachmentSendDialog
            composer={props.composer}
            enabled={props.enabled}
            canSendMedia={props.canSendMedia}
          />
        ) : null}
        {props.botControls?.isBot && !props.botControls.started ? (
          <BotControls {...commandControls()!} />
        ) : (
          <div class="mx-auto flex w-full min-w-0 max-w-3xl items-center gap-2">
            {props.botControls ? <BotControls {...commandControls()!} /> : null}
            <input
              class="sr-only"
              type="file"
              multiple={!props.composer.editing}
              disabled={!props.canSendMedia}
              onChange={(event) => {
                const files = event.currentTarget.files;
                if (props.canSendMedia && files?.length)
                  props.composer.attach(
                    [...files],
                    event.currentTarget.dataset.sendAs === 'file' ? 'file' : undefined,
                  );
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
              <PointMenu
                value={model.formatMenu}
                render={(position, closing) => (
                  <div
                    class="menu-surface composer-format-menu"
                    inert={closing}
                    aria-hidden={closing || undefined}
                    role="menu"
                    aria-label="Message formatting"
                    use={menuAtPoint(position)}
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
                )}
              />
              {props.replyKeyboardAvailable ? (
                <button
                  class="composer-icon-button"
                  title={props.replyKeyboard ? 'Hide bot keyboard' : 'Show bot keyboard'}
                  aria-label={props.replyKeyboard ? 'Hide bot keyboard' : 'Show bot keyboard'}
                  aria-expanded={Boolean(props.replyKeyboard)}
                  onClick={props.toggleReplyKeyboard}
                >
                  <Keyboard size={20} />
                </button>
              ) : null}
              <textarea
                rows="1"
                value={props.composer.attachments.length ? '' : props.composer.draft}
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
                  if (
                    commandQuery() &&
                    !event.shiftKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.altKey
                  ) {
                    const items = [
                      ...(model.element?.querySelectorAll<HTMLButtonElement>(
                        '.bot-command-menu [role="menuitem"]:not(:disabled)',
                      ) ?? []),
                    ];
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      closeCommands();
                      return;
                    }
                    if (
                      items.length &&
                      ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)
                    ) {
                      event.preventDefault();
                      if (event.key === 'Enter' || event.key === 'Tab') items[0]?.click();
                      else (event.key === 'ArrowUp' ? items.at(-1) : items[0])?.focus();
                      return;
                    }
                  }
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
                          (model.mentionIndex +
                            (event.key === 'ArrowUp' ? -1 : 1) +
                            members.length) %
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
                    if (props.forwardDraft) props.forwardDraft.send();
                    else props.composer.send();
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
                  if (event.currentTarget.selectionStart === event.currentTarget.selectionEnd)
                    return;
                  event.preventDefault();
                  setExpressionOpen(false);
                  send({
                    type: 'Fields',
                    fields: { formatMenu: { x: event.clientX, y: event.clientY } },
                  });
                }}
                placeholder={props.placeholder || 'Write a message'}
                aria-label="Message"
                readOnly={!props.enabled}
              />
              <div class="composer-attach-area">
                <ToggleMenu
                  value={model.attachmentMenuOpen || undefined}
                  render={(_, closing) => (
                    <div
                      class="menu-surface composer-attach-menu"
                      inert={closing}
                      aria-hidden={closing || undefined}
                      role="group"
                      aria-label="Attach"
                    >
                      <button
                        type="button"
                        disabled={!props.canSendMedia}
                        onClick={(event) => {
                          pickFiles(event, 'media');
                          send({ type: 'Fields', fields: { attachmentMenuOpen: false } });
                        }}
                      >
                        <Image size={20} /> Photo or video
                      </button>
                      <button
                        type="button"
                        disabled={!props.canSendMedia}
                        onClick={(event) => {
                          pickFiles(event, 'file');
                          send({ type: 'Fields', fields: { attachmentMenuOpen: false } });
                        }}
                      >
                        <FileText size={20} />
                        File
                      </button>
                      {props.sendPoll && !props.composer.editing ? (
                        <button
                          type="button"
                          disabled={!props.canSendPolls}
                          onClick={() =>
                            send({
                              type: 'Fields',
                              fields: { attachmentMenuOpen: false, pollOpen: true },
                            })
                          }
                        >
                          <ChartNoAxesColumn size={20} /> Poll
                        </button>
                      ) : null}
                    </div>
                  )}
                />
                <button
                  class="composer-icon-button"
                  title="Attach files or create a poll"
                  aria-expanded={model.attachmentMenuOpen}
                  onClick={() =>
                    send({
                      type: 'Fields',
                      fields: { attachmentMenuOpen: !model.attachmentMenuOpen },
                    })
                  }
                  disabled={!props.canSendMedia && !props.canSendPolls}
                  aria-label={props.composer.editing ? 'Replace media' : 'Attach files'}
                >
                  <Paperclip size={20} />
                </button>
              </div>
            </div>
            <button
              class="send-button"
              onClick={() =>
                props.forwardDraft ? props.forwardDraft.send() : props.composer.send()
              }
              disabled={
                props.forwardDraft?.busy ||
                (!props.forwardDraft &&
                  !props.composer.draft.trim() &&
                  props.composer.attachments.length === 0 &&
                  !props.composer.editing?.media) ||
                !props.enabled
              }
              aria-label="Send message"
            >
              <SendHorizontal size={18} />
            </button>
          </div>
        )}
        {props.replyKeyboard && props.onReplyButton ? (
          <div class="bot-reply-panel">
            <BotKeyboard
              keyboard={props.replyKeyboard}
              disabled={!props.enabled}
              busyButton={props.replyKeyboardBusy}
              label="Bot reply keyboard"
              onPress={props.onReplyButton}
            />
          </div>
        ) : null}
        {model.pollOpen && props.sendPoll ? (
          <PollCreateDialog
            close={() => send({ type: 'Fields', fields: { pollOpen: false } })}
            submit={props.sendPoll}
          />
        ) : null}
      </footer>
    );
  }),
);
