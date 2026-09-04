import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { Deferred, Effect } from 'effect';

import type { ChatMessage } from '../../domain/models';
import type { EffectConversation } from '../../telegram/core/conversation';
import type {
  EngineSnapshot,
  TelegramDialog,
  TelegramDraftDetails,
  TelegramReplyTarget,
  TelegramTextFormat,
} from '../../telegram/types';
import { stageAttachment, type StagedAttachment } from './outgoingAttachments';
import type { UiEffectRunner, UiLatestEffectRunner } from '../app/appRuntime';

const DRAFT_WRITE_DELAY_MS = 120;
const DRAFT_WRITE_TASK = 'composer:draft-write';
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
}

interface PendingDraftWrite {
  peerId: string;
  value: string;
  details?: TelegramDraftDetails;
  conversation: EffectConversation;
}

interface ComposerSessionOptions {
  conversation: Accessor<EffectConversation | undefined>;
  runEffect: UiEffectRunner;
  runLatestEffect: UiLatestEffectRunner;
  snapshot: Accessor<EngineSnapshot>;
  activePeerId: Accessor<string>;
  activeDialog: Accessor<TelegramDialog | undefined>;
  canSend: Accessor<boolean>;
  canSendMedia: Accessor<boolean>;
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
  const [draft, setDraft] = createSignal('');
  const [formats, setFormats] = createSignal<TelegramTextFormat[]>([]);
  const [attachments, setAttachments] = createSignal<StagedAttachment[]>([]);
  const [reply, setReply] = createSignal<ReplyTarget>();
  const [editing, setEditing] = createSignal<ChatMessage>();
  const attachmentDrafts = new Map<string, StagedAttachment[]>();
  let editRestore: EditRestore | undefined;
  let editVersion = 0;
  let pendingDraftWrite: PendingDraftWrite | undefined;
  let draftBurst = false;
  const draftWrites = new Set<Deferred.Deferred<void>>();
  let typingPeerId = '';
  let typingConversation: EffectConversation | undefined;
  let focusFrame: number | undefined;

  const focusComposer = () => {
    queueMicrotask(() => {
      options.focus();
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => {
        focusFrame = undefined;
        options.focus();
      });
    });
  };

  const rememberAttachments = (peerId: string, next: readonly StagedAttachment[]) => {
    if (!peerId || peerId === 'empty') return;
    if (next.length === 0) attachmentDrafts.delete(peerId);
    else attachmentDrafts.set(peerId, cloneAttachments(next));
  };
  const stopTyping = () => {
    const conversation = typingConversation;
    typingPeerId = '';
    typingConversation = undefined;
    void options
      .runLatestEffect(TYPING_TASK, conversation ? conversation.setTyping() : Effect.void)
      .catch(() => undefined);
  };
  const trackDraftWrite = <Value, Error>(write: Effect.Effect<Value, Error>) => {
    const completed = Deferred.makeUnsafe<void>();
    draftWrites.add(completed);
    return write.pipe(
      Effect.ensuring(
        Deferred.succeed(completed, undefined).pipe(
          Effect.andThen(
            Effect.sync(() => {
              draftWrites.delete(completed);
            }),
          ),
        ),
      ),
    );
  };
  const awaitDraftWrites = Effect.suspend(() =>
    Effect.forEach([...draftWrites], Deferred.await, { discard: true }),
  );
  const enqueueDraftWrite = (write: PendingDraftWrite) => {
    return options.runEffect(
      trackDraftWrite(write.conversation.setDraft(write.value, write.details)),
    );
  };
  const flushDraftWrite = (peerId?: string) => {
    const pending = pendingDraftWrite;
    if (peerId && pending && pending.peerId !== peerId) {
      return options.runEffect(awaitDraftWrites);
    }
    pendingDraftWrite = undefined;
    draftBurst = false;
    if (!pending) return options.runEffect(awaitDraftWrites);
    return options.runLatestEffect(
      DRAFT_WRITE_TASK,
      trackDraftWrite(pending.conversation.setDraft(pending.value, pending.details)),
    );
  };
  const scheduleDraftWrite = (write: PendingDraftWrite) => {
    pendingDraftWrite = write;
    if (!draftBurst) {
      draftBurst = true;
      pendingDraftWrite = undefined;
      void enqueueDraftWrite(write);
    }
    void options
      .runLatestEffect(
        DRAFT_WRITE_TASK,
        trackDraftWrite(
          Effect.sleep(DRAFT_WRITE_DELAY_MS).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                const pending = pendingDraftWrite;
                pendingDraftWrite = undefined;
                draftBurst = false;
                return pending
                  ? pending.conversation.setDraft(pending.value, pending.details)
                  : Effect.void;
              }),
            ),
          ),
        ),
      )
      .catch(() => undefined);
  };
  const cancelDraftWrite = () => {
    pendingDraftWrite = undefined;
    draftBurst = false;
    void options.runLatestEffect(DRAFT_WRITE_TASK, Effect.void).catch(() => undefined);
  };
  const replaceDraft = (value: string) => {
    editVersion += 1;
    setDraft(value);
  };
  const changeDraft = (value: string) => {
    options.beforeUiChange();
    editVersion += 1;
    const peerId = options.activePeerId();
    setDraft(value);
    if (editing()) return;
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
      void options.runEffect(conversation.setTyping('typing')).catch(() => undefined);
    }
    if (!value && typingPeerId === dialog.peer.id) {
      stopTyping();
      return;
    }
    if (value) {
      void options
        .runLatestEffect(
          TYPING_TASK,
          Effect.sleep(4_500).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (typingPeerId !== dialog.peer.id) return Effect.void;
                typingPeerId = '';
                typingConversation = undefined;
                return conversation.setTyping();
              }),
            ),
          ),
        )
        .catch(() => undefined);
    }
  };

  const currentDraftDetails = (): TelegramDraftDetails | undefined => {
    const currentFormats = formats().map((format) => ({ ...format }));
    const currentReply = reply();
    if (currentFormats.length === 0 && !currentReply) return undefined;
    return {
      formats: currentFormats,
      ...(currentReply ? { reply: { ...currentReply } } : {}),
    };
  };
  const persistDraftDetails = () => {
    const peerId = options.activePeerId();
    const conversation = options.conversation();
    if (peerId === 'empty' || !conversation || conversation.peerId !== peerId || editing()) return;
    const details = currentDraftDetails();
    void enqueueDraftWrite({
      peerId,
      value: draft(),
      ...(details ? { details } : {}),
      conversation,
    }).catch(() => undefined);
  };
  const changeFormats = (next: TelegramTextFormat[]) => {
    setFormats(next);
    persistDraftDetails();
  };

  const switchPeer = (previousPeerId: string, peerId: string, changing: boolean) => {
    if (changing) {
      void flushDraftWrite(previousPeerId).catch(() => undefined);
      if (editRestore) {
        rememberAttachments(editRestore.peerId, editRestore.attachments);
        editRestore = undefined;
      } else {
        rememberAttachments(previousPeerId, attachments());
      }
      setReply(undefined);
      setAttachments(cloneAttachments(attachmentDrafts.get(peerId) ?? []));
      setEditing(undefined);
      const details = options.snapshot().draftDetails[peerId];
      setFormats(details?.formats ? [...details.formats] : []);
      setReply(details?.reply ? { ...details.reply } : undefined);
      setDraft(options.snapshot().drafts[peerId] ?? '');
    }
    stopTyping();
  };

  const send = async () => {
    const body = draft();
    const capturedAttachments = cloneAttachments(attachments());
    const capturedEditing = editing();
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
    const capturedReply = reply() ? { ...reply()! } : undefined;
    const telegramReply: TelegramReplyTarget | undefined = capturedReply
      ? {
          messageId: capturedReply.messageId,
          ...(capturedReply.quoteText ? { quoteText: capturedReply.quoteText } : {}),
        }
      : undefined;
    const capturedFormats = formats().map((format) => ({ ...format }));
    const capturedVersion = editVersion;
    const pendingDraft = flushDraftWrite(peerId);

    options.beforeSend();
    options.onSend?.(body);
    stopTyping();
    setDraft('');
    setReply(undefined);
    setAttachments([]);
    if (!capturedEditing) rememberAttachments(peerId, []);
    setEditing(undefined);
    setFormats([]);
    try {
      await pendingDraft;
      if (capturedEditing) {
        const replacement = capturedAttachments[0];
        await options.runEffect(
          conversation.editMessage(
            Number(capturedEditing.id),
            body,
            capturedFormats,
            replacement ? { file: replacement.file, sendAs: replacement.sendAs } : undefined,
          ),
        );
        const restore =
          capturedRestore?.peerId === peerId
            ? capturedRestore
            : { peerId, text: '', formats: [], attachments: [] };
        if (editRestore === capturedRestore) editRestore = undefined;
        if (options.activePeerId() === peerId && editVersion === capturedVersion) {
          setDraft(restore.text);
          setFormats(restore.formats);
          setAttachments(cloneAttachments(restore.attachments));
          rememberAttachments(peerId, restore.attachments);
        }
        return;
      }
      if (capturedAttachments.length > 0) {
        void options.runEffect(conversation.setTyping('uploading')).catch(() => undefined);
        await options.runEffect(
          conversation.sendAttachments(
            capturedAttachments.map(({ file, sendAs }) => ({ file, sendAs })),
            body,
            telegramReply,
            capturedFormats,
          ),
        );
        void options.runEffect(conversation.setTyping()).catch(() => undefined);
      } else {
        await options.runEffect(conversation.sendDraft(body, telegramReply, capturedFormats));
      }
    } catch {
      const hasNewerState =
        options.activePeerId() !== peerId ||
        editVersion !== capturedVersion ||
        draft() !== '' ||
        formats().length > 0 ||
        attachments().length > 0 ||
        reply() !== undefined ||
        editing() !== undefined;
      if (!hasNewerState) {
        setDraft(body);
        setReply(capturedReply);
        setAttachments(cloneAttachments(capturedAttachments));
        setEditing(capturedEditing);
        setFormats(capturedFormats);
        if (!capturedEditing) {
          rememberAttachments(peerId, capturedAttachments);
          await options
            .runEffect(conversation.setDraft(body, currentDraftDetails()))
            .catch(() => undefined);
        }
      } else if (!capturedEditing && options.activePeerId() !== peerId) {
        rememberAttachments(peerId, capturedAttachments);
      }
    }
  };

  const attach = (files: File[]) => {
    if (files.length === 0) return;
    editVersion += 1;
    const staged = files.map(stageAttachment);
    setAttachments((current) => {
      const next = editing() ? staged.slice(0, 1) : [...current, ...staged];
      if (!editing()) rememberAttachments(options.activePeerId(), next);
      return next;
    });
  };
  const updateAttachment = (
    id: string,
    update: Partial<Pick<StagedAttachment, 'file' | 'sendAs'>>,
  ) => {
    editVersion += 1;
    setAttachments((current) => {
      const next = current.map((attachment) =>
        attachment.id === id ? { ...attachment, ...update } : attachment,
      );
      if (!editing()) rememberAttachments(options.activePeerId(), next);
      return next;
    });
  };
  const removeAttachment = (id: string) => {
    editVersion += 1;
    setAttachments((current) => {
      const next = current.filter((attachment) => attachment.id !== id);
      if (!editing()) rememberAttachments(options.activePeerId(), next);
      return next;
    });
  };
  const beginReply = (message: ChatMessage, element: HTMLElement) => {
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
    setReply({
      messageId: Number(message.id),
      preview: selectionInside ? selected : message.body || message.media?.name || 'Message',
      ...(selectionInside ? { quoteText: selected } : {}),
    });
    persistDraftDetails();
    selection?.removeAllRanges();
    focusComposer();
  };
  const beginEdit = (message: ChatMessage) => {
    options.beforeUiChange();
    if (!editing()) {
      rememberAttachments(options.activePeerId(), attachments());
      editRestore = {
        peerId: options.activePeerId(),
        text: draft(),
        formats: [...formats()],
        attachments: cloneAttachments(attachments()),
      };
    }
    setReply(undefined);
    setAttachments([]);
    setEditing(message);
    setDraft(message.body);
    setFormats(message.formats ? [...message.formats] : []);
    focusComposer();
  };
  const cancelEdit = () => {
    options.beforeUiChange();
    const restore = editRestore;
    editRestore = undefined;
    setEditing(undefined);
    setDraft(restore?.text ?? '');
    setFormats(restore?.formats ?? []);
    setAttachments(cloneAttachments(restore?.attachments ?? []));
    if (restore) rememberAttachments(restore.peerId, restore.attachments);
    focusComposer();
  };
  const reset = () => {
    stopTyping();
    cancelDraftWrite();
    setDraft('');
    setFormats([]);
    setAttachments([]);
    setReply(undefined);
    setEditing(undefined);
    editRestore = undefined;
  };

  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    stopTyping();
    void flushDraftWrite().catch(() => undefined);
  });
  return {
    draft,
    formats,
    attachments,
    reply,
    editing,
    setFormats: changeFormats,
    changeDraft,
    replaceDraft,
    switchPeer,
    send,
    attach,
    updateAttachment,
    removeAttachment,
    beginReply,
    forceReply: (messageId: number, preview: string) => {
      setReply({ messageId, preview });
      persistDraftDetails();
      focusComposer();
    },
    focus: focusComposer,
    beginEdit,
    cancelEdit,
    clearReply: () => {
      if (!reply()) return;
      setReply(undefined);
      persistDraftDetails();
    },
    reset,
  };
}

export type ComposerSession = ReturnType<typeof createComposerSession>;
