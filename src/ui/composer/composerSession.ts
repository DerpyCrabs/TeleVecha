import { createSignal, onCleanup, type Accessor } from 'solid-js';

import type { ChatMessage } from '../../domain/models';
import type { Conversation } from '../../telegram/core/conversation';
import type {
  EngineSnapshot,
  TelegramDialog,
  TelegramReplyTarget,
  TelegramTextFormat,
} from '../../telegram/types';
import { stageAttachment, type StagedAttachment } from './outgoingAttachments';

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

interface ComposerSessionOptions {
  conversation: Accessor<Conversation | undefined>;
  snapshot: Accessor<EngineSnapshot>;
  activePeerId: Accessor<string>;
  activeDialog: Accessor<TelegramDialog | undefined>;
  canSend: Accessor<boolean>;
  beforeUiChange: () => void;
  focus: () => void;
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
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  let typingPeerId = '';
  let typingConversation: Conversation | undefined;

  const rememberAttachments = (peerId: string, next: readonly StagedAttachment[]) => {
    if (!peerId || peerId === 'empty') return;
    if (next.length === 0) attachmentDrafts.delete(peerId);
    else attachmentDrafts.set(peerId, cloneAttachments(next));
  };
  const stopTyping = () => {
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = undefined;
    const conversation = typingConversation;
    typingPeerId = '';
    typingConversation = undefined;
    if (conversation) void conversation.setTyping();
  };
  const replaceDraft = (value: string) => {
    editVersion += 1;
    setDraft(value);
  };
  const changeDraft = (value: string) => {
    options.beforeUiChange();
    replaceDraft(value);
    if (editing()) return;
    const peerId = options.activePeerId();
    if (peerId === 'empty') return;
    const conversation = options.conversation();
    if (!conversation || conversation.peerId !== peerId) return;
    void conversation.setDraft(value).catch(() => undefined);
    const dialog = options.activeDialog();
    if (!dialog || !options.snapshot().online) return;
    if (typingTimer) clearTimeout(typingTimer);
    if (value && typingPeerId !== dialog.peer.id) {
      typingPeerId = dialog.peer.id;
      typingConversation = conversation;
      void conversation.setTyping('typing');
    }
    if (!value && typingPeerId === dialog.peer.id) {
      typingPeerId = '';
      typingConversation = undefined;
      void conversation.setTyping();
    }
    typingTimer = setTimeout(() => {
      if (typingPeerId === dialog.peer.id) {
        typingPeerId = '';
        typingConversation = undefined;
        void conversation.setTyping();
      }
    }, 4_500);
  };

  const switchPeer = (previousPeerId: string, peerId: string, changing: boolean) => {
    if (changing) {
      if (editRestore) {
        rememberAttachments(editRestore.peerId, editRestore.attachments);
        editRestore = undefined;
      } else {
        rememberAttachments(previousPeerId, attachments());
      }
      setReply(undefined);
      setAttachments(cloneAttachments(attachmentDrafts.get(peerId) ?? []));
      setEditing(undefined);
      setFormats([]);
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
    if (!dialog || !conversation || conversation.peerId !== dialog.peer.id || !options.canSend()) {
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

    stopTyping();
    setDraft('');
    setReply(undefined);
    setAttachments([]);
    if (!capturedEditing) rememberAttachments(peerId, []);
    setEditing(undefined);
    setFormats([]);
    try {
      if (capturedEditing) {
        const replacement = capturedAttachments[0];
        await conversation.editMessage(
          Number(capturedEditing.id),
          body,
          capturedFormats,
          replacement ? { file: replacement.file, sendAs: replacement.sendAs } : undefined,
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
        void conversation.setTyping('uploading');
        await conversation.sendAttachments(
          capturedAttachments.map(({ file, sendAs }) => ({ file, sendAs })),
          body,
          telegramReply,
          capturedFormats,
        );
        void conversation.setTyping();
      } else {
        await conversation.sendDraft(body, telegramReply, capturedFormats);
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
          await conversation.setDraft(body).catch(() => undefined);
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
    selection?.removeAllRanges();
    queueMicrotask(options.focus);
  };
  const beginEdit = (message: ChatMessage) => {
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
  };
  const cancelEdit = () => {
    const restore = editRestore;
    editRestore = undefined;
    setEditing(undefined);
    setDraft(restore?.text ?? '');
    setFormats(restore?.formats ?? []);
    setAttachments(cloneAttachments(restore?.attachments ?? []));
    if (restore) rememberAttachments(restore.peerId, restore.attachments);
  };
  const reset = () => {
    stopTyping();
    setDraft('');
    setFormats([]);
    setAttachments([]);
    setReply(undefined);
    setEditing(undefined);
    editRestore = undefined;
  };

  onCleanup(stopTyping);
  return {
    draft,
    formats,
    attachments,
    reply,
    editing,
    setFormats,
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
      queueMicrotask(options.focus);
    },
    beginEdit,
    cancelEdit,
    clearReply: () => setReply(undefined),
    reset,
  };
}

export type ComposerSession = ReturnType<typeof createComposerSession>;
