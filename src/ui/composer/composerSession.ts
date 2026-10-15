import { shiftFormats } from './mentions';
import { modelOwner } from 'effectweb';
import { Effect, Fiber } from 'effect';
import type { ChatMessage } from '../../domain/models';
import type { EffectConversation } from '../../telegram/core/conversation';
import type {
  EngineSnapshot,
  TelegramDialog,
  TelegramGroupMember,
  TelegramGroupMemberPage,
  TelegramPeer,
  TelegramDraftDetails,
  TelegramReplyTarget,
  TelegramTextFormat,
} from '../../telegram/types';
import type { UiTaskRunner } from '../app/appRuntime';
import { stageAttachment, type StagedAttachment } from './outgoingAttachments';
import { prepareAttachment } from './attachmentMetadata';
import { mediaPreview } from '../conversation/presentation';
const DRAFT_WRITE_DELAY_MS = 120;
const DRAFT_WRITE_TASK = 'composer:draft-write';
const MENTION_MEMBERS_TASK = 'composer:members';
const TYPING_TASK = 'composer:typing';
interface ReplyTarget {
  messageId: number;
  preview: string;
  quoteText?: string | undefined;
}
interface EditRestore {
  peerId: string;
  text: string;
  formats: TelegramTextFormat[];
  attachments: StagedAttachment[];
  reply: ReplyTarget | undefined;
}
interface PendingDraftWrite {
  peerId: string;
  value: string;
  details?: TelegramDraftDetails;
  conversation: EffectConversation;
}
interface ComposerSessionOptions {
  getMentionMembers?: (peer: TelegramPeer) => Effect.Effect<TelegramGroupMemberPage, unknown>;
  conversation: () => EffectConversation | undefined;
  runTask: UiTaskRunner;
  snapshot: () => EngineSnapshot;
  activePeerId: () => string;
  activeDialog: () => TelegramDialog | undefined;
  canSend: () => boolean;
  canSendMedia: () => boolean;
  beforeUiChange: () => void;
  beforeSend: () => void;
  focus: () => void;
  onReply?: ((messageId: number) => void) | undefined;
  onSend?: ((text: string) => void) | undefined;
}
function cloneAttachments(attachments: readonly StagedAttachment[]) {
  return attachments.map((attachment) => ({ ...attachment }));
}
export function createComposerSession(options: ComposerSessionOptions) {
  type ComposerSessionModel = {
    mentionMembers: TelegramGroupMember[];
    draft: string;
    formats: TelegramTextFormat[];
    attachments: StagedAttachment[];
    reply: ReplyTarget | undefined;
    editing: ChatMessage | undefined;
  };
  const empty = (): ComposerSessionModel => ({
    mentionMembers: [],
    draft: '',
    formats: [],
    attachments: [],
    reply: undefined,
    editing: undefined,
  });
  const owner = modelOwner(empty());
  const attachmentDrafts = new Map<string, StagedAttachment[]>();
  let editRestore: EditRestore | undefined;
  let editVersion = 0;
  let mentionPeerId = '';
  let pendingDraftWrite: PendingDraftWrite | undefined;
  let draftBurst = false;
  const draftWrites = new Set<{ peerId: string; fiber: Fiber.Fiber<void, unknown> }>();
  let typingPeerId = '';
  let typingConversation: EffectConversation | undefined;
  let focusFrame: number | undefined;
  const focusComposer = () => {
    const requestedFrom = globalThis.document?.activeElement;
    queueMicrotask(() => {
      const activeElement = globalThis.document?.activeElement;
      // Removing a focused menu item leaves the body active; it is not a new user choice.
      const removedOrigin =
        requestedFrom && !requestedFrom.isConnected && activeElement === globalThis.document?.body;
      if (owner.disposed || (activeElement !== requestedFrom && !removedOrigin)) return;
      options.focus();
      const focusedElement = globalThis.document?.activeElement;
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => {
        focusFrame = undefined;
        // A later user focus choice takes precedence over this rendering retry.
        if (!owner.disposed && globalThis.document?.activeElement === focusedElement)
          options.focus();
      });
    });
  };
  const rememberAttachments = (peerId: string, next: readonly StagedAttachment[]) => {
    if (!peerId || peerId === 'empty') return;
    if (next.length === 0) attachmentDrafts.delete(peerId);
    else attachmentDrafts.set(peerId, cloneAttachments(next));
  };
  // Requests use the application scope; only debounce/inactivity timers belong to this UI.
  const signalTyping = (effect: Effect.Effect<void, unknown>) => {
    options.runTask(effect.pipe(Effect.ignore));
  };
  const stopTyping = () => {
    const conversation = typingConversation;
    typingPeerId = '';
    typingConversation = undefined;
    owner.cancel(TYPING_TASK);
    if (conversation) signalTyping(conversation.setTyping());
  };
  const enqueueDraftWrite = (write: PendingDraftWrite) => {
    const fiber = options.runTask(write.conversation.setDraft(write.value, write.details));
    const entry = { peerId: write.peerId, fiber };
    draftWrites.add(entry);
    fiber.addObserver(() => draftWrites.delete(entry));
  };
  // Capture the barrier now, before the composer is cleared or another chat starts typing.
  // The engine serializes durable writes; the UI only waits for this peer's accepted writes.
  const flushDraftWrite = (peerId?: string) => {
    const pending = pendingDraftWrite;
    if (!peerId || !pending || pending.peerId === peerId) {
      owner.cancel(DRAFT_WRITE_TASK);
      pendingDraftWrite = undefined;
      draftBurst = false;
      if (pending) enqueueDraftWrite(pending);
    }
    const writes = [...draftWrites].filter((write) => !peerId || write.peerId === peerId);
    return Effect.forEach(writes, ({ fiber }) => Fiber.join(fiber), { discard: true });
  };
  const scheduleDraftWrite = (write: PendingDraftWrite) => {
    pendingDraftWrite = write;
    if (!draftBurst) {
      draftBurst = true;
      pendingDraftWrite = undefined;
      enqueueDraftWrite(write);
    }
    owner.run(
      DRAFT_WRITE_TASK,
      Effect.sleep(DRAFT_WRITE_DELAY_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const pending = pendingDraftWrite;
            pendingDraftWrite = undefined;
            draftBurst = false;
            if (pending) enqueueDraftWrite(pending);
          }),
        ),
      ),
      'replace',
    );
  };
  const cancelDraftWrite = () => {
    pendingDraftWrite = undefined;
    draftBurst = false;
    owner.cancel(DRAFT_WRITE_TASK);
  };
  const replaceDraft = (value: string) => {
    editVersion += 1;
    owner.patch({ draft: value });
  };
  const changeDraft = (value: string) => {
    options.beforeUiChange();
    editVersion += 1;
    const peerId = options.activePeerId();
    owner.patch({
      draft: value,
      formats: shiftFormats(owner.read().formats, owner.read().draft, value),
    });
    if (owner.read().editing) return;
    if (peerId === 'empty') return;
    const conversation = options.conversation();
    if (!conversation || conversation.peerId !== peerId) return;
    const details = currentDraftDetails();
    scheduleDraftWrite({ peerId, value, ...(details ? { details } : {}), conversation });
    const dialog = options.activeDialog();
    if (!dialog || !options.snapshot().online) return;
    if (value && typingPeerId !== dialog.peer.id) {
      typingPeerId = dialog.peer.id;
      typingConversation = conversation;
      signalTyping(conversation.setTyping('typing'));
    }
    if (!value && typingPeerId === dialog.peer.id) {
      stopTyping();
      return;
    }
    if (value) {
      owner.run(
        TYPING_TASK,
        Effect.sleep(4_500).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (typingPeerId !== dialog.peer.id) return;
              typingPeerId = '';
              typingConversation = undefined;
              signalTyping(conversation.setTyping());
            }),
          ),
        ),
        'replace',
      );
    }
  };
  const currentDraftDetails = (): TelegramDraftDetails | undefined => {
    const currentFormats = owner.read().formats.map((format) => ({ ...format }));
    const currentReply = owner.read().reply;
    if (currentFormats.length === 0 && !currentReply) return undefined;
    return { formats: currentFormats, ...(currentReply ? { reply: { ...currentReply } } : {}) };
  };
  const persistDraftDetails = () => {
    const peerId = options.activePeerId();
    const conversation = options.conversation();
    if (
      peerId === 'empty' ||
      !conversation ||
      conversation.peerId !== peerId ||
      owner.read().editing
    )
      return;
    // This write includes the latest text, so an older debounce must not overwrite its details.
    cancelDraftWrite();
    const details = currentDraftDetails();
    enqueueDraftWrite({
      peerId,
      value: owner.read().draft,
      ...(details ? { details } : {}),
      conversation,
    });
  };
  const changeFormats = (next: TelegramTextFormat[]) => {
    editVersion += 1;
    owner.patch({ formats: next });
    persistDraftDetails();
  };
  const switchPeer = (previousPeerId: string, peerId: string, changing: boolean) => {
    if (changing) {
      owner.cancel(MENTION_MEMBERS_TASK);
      mentionPeerId = '';
      editVersion += 1;
      options.runTask(flushDraftWrite(previousPeerId).pipe(Effect.ignore));
      if (editRestore) {
        rememberAttachments(editRestore.peerId, editRestore.attachments);
        editRestore = undefined;
      } else {
        rememberAttachments(previousPeerId, owner.read().attachments);
      }
      const details = options.snapshot().draftDetails[peerId];
      owner.patch({
        mentionMembers: [],
        attachments: cloneAttachments(attachmentDrafts.get(peerId) ?? []),
        editing: undefined,
        formats: details?.formats ? [...details.formats] : [],
        reply: details?.reply ? { ...details.reply } : undefined,
        draft: options.snapshot().drafts[peerId] ?? '',
      });
    }
    stopTyping();
  };
  const send = Effect.gen(function* () {
    const body = owner.read().draft;
    const capturedAttachments = cloneAttachments(owner.read().attachments);
    const capturedEditing = owner.read().editing;
    const capturedRestore = editRestore;
    if (!body.trim() && capturedAttachments.length === 0 && !capturedEditing?.media) return;
    const dialog = options.activeDialog();
    const conversation = options.conversation();
    if (
      !dialog ||
      !conversation ||
      conversation.peerId !== dialog.peer.id ||
      !options.canSend() ||
      (capturedAttachments.length > 0 && !options.canSendMedia())
    ) {
      return;
    }
    const peerId = dialog.peer.id;
    const capturedReply = owner.read().reply ? { ...owner.read().reply! } : undefined;
    const telegramReply: TelegramReplyTarget | undefined = capturedReply
      ? {
          messageId: capturedReply.messageId,
          ...(capturedReply.quoteText ? { quoteText: capturedReply.quoteText } : {}),
        }
      : undefined;
    const capturedFormats = owner.read().formats.map((format) => ({ ...format }));
    const capturedVersion = editVersion;
    const hasNewerState = () =>
      owner.disposed ||
      options.activePeerId() !== peerId ||
      editVersion !== capturedVersion ||
      owner.read().draft !== '' ||
      owner.read().formats.length > 0 ||
      owner.read().attachments.length > 0 ||
      owner.read().reply !== undefined ||
      owner.read().editing !== undefined;
    const pendingDraft = flushDraftWrite(peerId);
    options.beforeSend();
    options.onSend?.(body);
    stopTyping();
    mentionPeerId = '';
    owner.cancel(MENTION_MEMBERS_TASK);
    owner.patch(empty());
    if (!capturedEditing) rememberAttachments(peerId, []);
    yield* Effect.gen(function* () {
      yield* pendingDraft;
      if (capturedEditing) {
        const replacement = capturedAttachments[0]
          ? yield* prepareAttachment(capturedAttachments[0])
          : undefined;
        yield* conversation.editMessage(
          Number(capturedEditing.id),
          body,
          capturedFormats,
          replacement,
        );
        const restore =
          capturedRestore?.peerId === peerId
            ? capturedRestore
            : { peerId, text: '', formats: [], attachments: [], reply: undefined };
        if (editRestore === capturedRestore) editRestore = undefined;
        if (!hasNewerState()) {
          owner.patch({
            draft: restore.text,
            formats: restore.formats,
            attachments: cloneAttachments(restore.attachments),
            reply: restore.reply,
          });
          rememberAttachments(peerId, restore.attachments);
        }
        return;
      }
      if (capturedAttachments.length > 0) {
        signalTyping(conversation.setTyping('uploading'));
        yield* Effect.forEach(
          capturedAttachments,
          ({ file, sendAs }) => prepareAttachment({ file, sendAs }),
          { concurrency: 4 },
        ).pipe(
          Effect.flatMap((attachments) =>
            conversation.sendAttachments(attachments, body, telegramReply, capturedFormats),
          ),
          Effect.ensuring(Effect.sync(() => signalTyping(conversation.setTyping()))),
        );
      } else {
        yield* conversation.sendDraft(body, telegramReply, capturedFormats);
      }
    }).pipe(
      Effect.catchCause(() =>
        Effect.gen(function* () {
          if (!hasNewerState()) {
            owner.patch({
              draft: body,
              reply: capturedReply,
              attachments: cloneAttachments(capturedAttachments),
              editing: capturedEditing,
              formats: capturedFormats,
            });
            if (!capturedEditing) {
              rememberAttachments(peerId, capturedAttachments);
              yield* conversation.setDraft(body, currentDraftDetails()).pipe(Effect.ignore);
            }
          } else if (!owner.disposed && !capturedEditing && options.activePeerId() !== peerId) {
            rememberAttachments(peerId, capturedAttachments);
          }
        }),
      ),
    );
  });
  const changeAttachments = (attachments: StagedAttachment[]) => {
    if (!owner.read().editing) rememberAttachments(options.activePeerId(), attachments);
    owner.patch({ attachments });
  };
  const attach = (files: File[]) => {
    if (files.length === 0) return;
    editVersion += 1;
    const staged = files.map(stageAttachment);
    changeAttachments(
      owner.read().editing ? staged.slice(0, 1) : [...owner.read().attachments, ...staged],
    );
  };
  const updateAttachment = (
    id: string,
    update: Partial<Pick<StagedAttachment, 'file' | 'sendAs'>>,
  ) => {
    editVersion += 1;
    changeAttachments(
      owner
        .read()
        .attachments.map((attachment) =>
          attachment.id === id ? { ...attachment, ...update } : attachment,
        ),
    );
  };
  const removeAttachment = (id: string) => {
    editVersion += 1;
    changeAttachments(owner.read().attachments.filter((attachment) => attachment.id !== id));
  };
  const beginReply = (message: ChatMessage, element: HTMLElement) => {
    editVersion += 1;
    options.beforeUiChange();
    options.onReply?.(Number(message.id));
    const selection = window.getSelection();
    const selected = selection?.toString().trim() ?? '';
    const anchorNode = selection?.anchorNode;
    const focusNode = selection?.focusNode;
    const selectionInside =
      selected.length > 0 &&
      Boolean(
        anchorNode && focusNode && element.contains(anchorNode) && element.contains(focusNode),
      );
    owner.patch({
      reply: {
        messageId: Number(message.id),
        preview: selectionInside
          ? selected
          : message.body || (message.media ? mediaPreview(message.media, true) : 'Message'),
        ...(selectionInside ? { quoteText: selected } : {}),
      },
    });
    persistDraftDetails();
    selection?.removeAllRanges();
    focusComposer();
  };
  const beginEdit = (message: ChatMessage) => {
    editVersion += 1;
    options.beforeUiChange();
    if (!owner.read().editing) {
      rememberAttachments(options.activePeerId(), owner.read().attachments);
      editRestore = {
        peerId: options.activePeerId(),
        text: owner.read().draft,
        formats: [...owner.read().formats],
        attachments: cloneAttachments(owner.read().attachments),
        reply: owner.read().reply,
      };
    }
    owner.patch({
      reply: undefined,
      attachments: [],
      editing: message,
      draft: message.body,
      formats: message.formats ? [...message.formats] : [],
    });
    focusComposer();
  };
  const cancelEdit = () => {
    editVersion += 1;
    options.beforeUiChange();
    const restore = editRestore;
    editRestore = undefined;
    owner.patch({
      editing: undefined,
      draft: restore?.text ?? '',
      formats: restore?.formats ?? [],
      attachments: cloneAttachments(restore?.attachments ?? []),
      reply: restore?.reply,
    });
    if (restore) rememberAttachments(restore.peerId, restore.attachments);
    focusComposer();
  };
  const reset = () => {
    editVersion += 1;
    stopTyping();
    cancelDraftWrite();
    mentionPeerId = '';
    owner.cancel(MENTION_MEMBERS_TASK);
    owner.patch(empty());
    editRestore = undefined;
  };
  const loadMentionMembers = () => {
    const peer = options.activeDialog()?.peer;
    if (!peer || peer.kind === 'user' || !options.getMentionMembers || mentionPeerId === peer.id)
      return;
    mentionPeerId = peer.id;
    owner.run(
      MENTION_MEMBERS_TASK,
      options.getMentionMembers(peer).pipe(
        Effect.tap((page) =>
          Effect.sync(() => {
            if (options.activePeerId() === peer.id) owner.patch({ mentionMembers: page.members });
          }),
        ),
        Effect.catchCause(() =>
          Effect.sync(() => {
            mentionPeerId = '';
          }),
        ),
      ),
      'replace',
    );
  };
  const actions = {
    loadMentionMembers,
    setFormats: changeFormats,
    changeDraft,
    replaceDraft,
    switchPeer,
    send: () => {
      if (!owner.disposed) options.runTask(send);
    },
    attach,
    updateAttachment,
    removeAttachment,
    beginReply,
    forceReply: (messageId: number, preview: string) => {
      editVersion += 1;
      owner.patch({ reply: { messageId, preview } });
      persistDraftDetails();
      focusComposer();
    },
    focus: focusComposer,
    beginEdit,
    cancelEdit,
    clearReply: () => {
      if (!owner.read().reply) return;
      editVersion += 1;
      owner.patch({ reply: undefined });
      persistDraftDetails();
    },
    reset,
  };
  return {
    ...actions,
    model: owner.read,
    subscribe: owner.source.subscribe,
    dispose: () => {
      if (owner.disposed) return;
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      stopTyping();
      options.runTask(flushDraftWrite().pipe(Effect.ignore));
      owner.dispose();
    },
    snapshot: () => ({
      ...actions,
      mentionMembers: owner.read().mentionMembers,
      draft: owner.read().draft,
      formats: owner.read().formats,
      attachments: owner.read().attachments,
      reply: owner.read().reply,
      editing: owner.read().editing,
    }),
  };
}
export type ComposerSession = ReturnType<ReturnType<typeof createComposerSession>['snapshot']>;
