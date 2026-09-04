import { createUiResource, useUiModel } from '../reactivity/solid';
import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js';
import type { Effect } from 'effect';

import type { EffectConversation } from '../../telegram/core/conversation';
import type { MessagingError } from '../../telegram/core/messagingError';
import type {
  EngineSnapshot,
  TelegramBotButton,
  TelegramBotCommand,
  TelegramDialog,
  TelegramPeer,
  TelegramResourceInvalidation,
  TelegramUrlAuthAcceptOptions,
  TelegramUrlAuthResult,
} from '../../telegram/types';
import { safeExternalUrl } from '../shared/safeUrl';
import { subscribeAtUi, type UiEffectRunner } from '../app/appRuntime';

interface PendingBotUrlAuth {
  peer: TelegramPeer;
  messageId: number;
  buttonId: number;
  fallbackUrl?: string | undefined;
  request: Extract<TelegramUrlAuthResult, { kind: 'request' }>;
  generation: number;
  owner: string;
}

interface PendingInlineSwitch {
  query: string;
  botUsername?: string | undefined;
  owner: string;
}

interface BotSessionOptions {
  conversation: Accessor<EffectConversation | undefined>;
  runEffect: UiEffectRunner;
  snapshot: Accessor<EngineSnapshot>;
  activePeerId: Accessor<string>;
  activeDialog: Accessor<TelegramDialog | undefined>;
  selectChat: (peerId: string) => Promise<boolean>;
  setDraft: (value: string) => void;
  setPeerDraft: (peerId: string, value: string) => Effect.Effect<unknown, MessagingError>;
  dismissSingleUseKeyboard: (owner: string) => void;
  focusComposer: () => void;
  resources: {
    subscribeResources(
      listener: (event: TelegramResourceInvalidation) => void,
    ): Effect.Effect<Effect.Effect<void>, MessagingError>;
  };
}

export function createBotSession(options: BotSessionOptions) {
  const [commandsRequested, setCommandsRequested] = createSignal('');
  const model = useUiModel();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [buttonBusy, setButtonBusy] = createSignal<{ owner: string; key: string }>();
  const [notice, setNotice] = createSignal('');
  const [urlAuth, setUrlAuth] = createSignal<PendingBotUrlAuth>();
  const [urlAuthBusy, setUrlAuthBusy] = createSignal(false);
  const [inlineSwitch, setInlineSwitch] = createSignal<PendingInlineSwitch>();
  let actionGeneration = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  const isCurrent = (peerId: string, generation: number) =>
    options.activePeerId() === peerId && actionGeneration === generation;
  const currentConversation = (peerId: string) => {
    const conversation = options.conversation();
    return conversation?.peerId === peerId ? conversation : undefined;
  };
  const focusComposer = () => queueMicrotask(options.focusComposer);
  const showNotice = (message: string) => {
    if (noticeTimer) clearTimeout(noticeTimer);
    setNotice(message);
    noticeTimer = setTimeout(() => {
      setNotice('');
      noticeTimer = undefined;
    }, 5_000);
  };
  const openUrl = (value: string | undefined) => {
    const url = safeExternalUrl(value);
    if (!url) {
      showNotice('Telegram returned an unsafe or invalid link.');
      return;
    }
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) showNotice('The browser blocked the new tab.');
  };

  const [loadedCommands] = createUiResource(
    () => {
      const dialog = options.activeDialog();
      const conversation = dialog && currentConversation(dialog.peer.id);
      return conversation &&
        (dialog?.peer.kind === 'group' || (dialog?.bot && commandsRequested() === dialog.peer.id))
        ? conversation
        : false;
    },
    (conversation) => conversation.getBotCommands(),
    { namespace: 'bot-commands', key: (conversation) => conversation.peerId },
  );
  const commands = () => loadedCommands() ?? [];
  const commandsLoading = () => loadedCommands.loading;
  const loadCommands = async () => {
    setCommandsRequested(options.activePeerId());
  };

  createEffect(
    on(
      () => `${options.activePeerId()}\0${options.conversation()?.peerId ?? ''}`,
      () => {
        const peerId = options.activePeerId();
        const conversationPeerId = options.conversation()?.peerId ?? '';
        actionGeneration += 1;
        setCommandsRequested('');
        setMenuOpen(false);
        setStarting(false);
        setButtonBusy(undefined);
        setNotice('');
        setUrlAuth(undefined);
        setUrlAuthBusy(false);
        setInlineSwitch(undefined);
        if (noticeTimer) clearTimeout(noticeTimer);
        const dialog = options.activeDialog();
        if (conversationPeerId === peerId && dialog?.peer.kind === 'group') {
          void loadCommands().catch(() => undefined);
        }
      },
    ),
  );

  onCleanup(
    subscribeAtUi(
      options.runEffect,
      options.resources.subscribeResources((event) => {
        if (
          event.kind !== 'bot-commands' ||
          (event.peerId !== undefined && event.peerId !== options.activePeerId())
        )
          return;
        model.invalidate(
          event.peerId === undefined ? 'bot-commands:' : `bot-commands:${event.peerId}`,
        );
      }),
    ),
  );

  const toggleMenu = () => {
    const open = !menuOpen();
    setMenuOpen(open);
    if (open) void loadCommands().catch(() => undefined);
  };
  const start = async () => {
    const dialog = options.activeDialog();
    if (!dialog?.bot || starting()) return;
    const peerId = dialog.peer.id;
    const generation = actionGeneration;
    setStarting(true);
    setMenuOpen(false);
    try {
      const conversation = currentConversation(peerId);
      if (conversation) await options.runEffect(conversation.startBot());
    } finally {
      if (isCurrent(peerId, generation)) setStarting(false);
    }
  };
  const sendCommand = (command: TelegramBotCommand) => {
    const dialog = options.activeDialog();
    if (!dialog) return;
    setMenuOpen(false);
    const suffix = dialog.bot || !command.botUsername ? '' : `@${command.botUsername}`;
    const conversation = currentConversation(dialog.peer.id);
    if (conversation) {
      void options
        .runEffect(conversation.sendDraft(`/${command.command}${suffix}`))
        .catch(() => undefined);
    }
  };

  const press = async (
    button: TelegramBotButton,
    owner: string,
    key: string,
    messageId?: number,
  ) => {
    const dialog = options.activeDialog();
    if (!dialog || buttonBusy()) return;
    const peer = { ...dialog.peer };
    const peerId = peer.id;
    const generation = actionGeneration;
    setButtonBusy({ owner, key });
    try {
      if (button.kind === 'text') {
        const conversation = currentConversation(peerId);
        if (conversation) await options.runEffect(conversation.sendDraft(button.text));
        if (isCurrent(peerId, generation)) options.dismissSingleUseKeyboard(owner);
        return;
      }
      if (button.kind === 'url') {
        if (isCurrent(peerId, generation)) {
          openUrl(button.url);
          options.dismissSingleUseKeyboard(owner);
        }
        return;
      }
      if (button.kind === 'url-auth') {
        if (messageId === undefined || button.buttonId === undefined) {
          if (isCurrent(peerId, generation)) {
            showNotice('This sign-in button is missing its Telegram authorization data.');
          }
          return;
        }
        const conversation = currentConversation(peerId);
        const result = conversation
          ? await options.runEffect(conversation.requestUrlAuth(messageId, button.buttonId))
          : undefined;
        if (!isCurrent(peerId, generation)) return;
        if (!result) {
          showNotice('Telegram sign-in is unavailable for this button.');
          return;
        }
        if (result.kind === 'request') {
          setUrlAuth({
            peer,
            messageId,
            buttonId: button.buttonId,
            fallbackUrl: button.url,
            request: result,
            generation,
            owner,
          });
          return;
        }
        openUrl(result.kind === 'accepted' ? (result.url ?? button.url) : button.url);
        options.dismissSingleUseKeyboard(owner);
        return;
      }
      if (button.kind === 'copy') {
        await navigator.clipboard.writeText(button.copyText ?? '');
        if (isCurrent(peerId, generation)) {
          showNotice('Copied to the clipboard.');
          options.dismissSingleUseKeyboard(owner);
        }
        return;
      }
      if (button.kind === 'callback') {
        if (messageId === undefined || !button.data) {
          if (isCurrent(peerId, generation)) {
            showNotice('This bot button is missing its callback data.');
          }
          return;
        }
        const conversation = currentConversation(peerId);
        const answer = conversation
          ? await options.runEffect(conversation.answerBotCallback(messageId, button.data))
          : undefined;
        if (!isCurrent(peerId, generation)) return;
        if (answer?.url) openUrl(answer.url);
        if (answer?.message) showNotice(answer.message);
        options.dismissSingleUseKeyboard(owner);
        return;
      }
      if (button.kind === 'switch-inline') {
        if (!button.samePeer) {
          if (isCurrent(peerId, generation)) {
            setInlineSwitch({
              query: button.query ?? '',
              ...(button.botUsername ? { botUsername: button.botUsername } : {}),
              owner,
            });
          }
          return;
        }
        const prefix = button.botUsername ? `@${button.botUsername} ` : '';
        const nextDraft = `${prefix}${button.query ?? ''}`;
        if (!isCurrent(peerId, generation)) return;
        options.setDraft(nextDraft);
        const conversation = currentConversation(peerId);
        if (conversation) await options.runEffect(conversation.setDraft(nextDraft));
        if (!isCurrent(peerId, generation)) return;
        options.dismissSingleUseKeyboard(owner);
        focusComposer();
        return;
      }
      if (isCurrent(peerId, generation)) showNotice('This Telegram button type is not supported.');
    } catch {
      if (isCurrent(peerId, generation)) showNotice('The bot action failed.');
    } finally {
      if (isCurrent(peerId, generation)) {
        setButtonBusy((current) =>
          current?.owner === owner && current.key === key ? undefined : current,
        );
      }
    }
  };

  const chooseInlineChat = async (peerId: string) => {
    const pending = inlineSwitch();
    if (!pending) return;
    const prefix = pending.botUsername ? `@${pending.botUsername} ` : '';
    const nextDraft = `${prefix}${pending.query}`;
    options.dismissSingleUseKeyboard(pending.owner);
    setInlineSwitch(undefined);
    await options.runEffect(options.setPeerDraft(peerId, nextDraft));
    if (!(await options.selectChat(peerId))) return;
    options.setDraft(nextDraft);
    if (options.activePeerId() === peerId) focusComposer();
  };

  const acceptUrlAuth = async (acceptOptions: TelegramUrlAuthAcceptOptions) => {
    const pending = urlAuth();
    if (!pending || urlAuthBusy()) return;
    setUrlAuthBusy(true);
    try {
      const conversation = currentConversation(pending.peer.id);
      const result = conversation
        ? await options.runEffect(
            conversation.acceptUrlAuth(pending.messageId, pending.buttonId, acceptOptions),
          )
        : undefined;
      if (!isCurrent(pending.peer.id, pending.generation)) return;
      if (!result) throw new Error('Telegram URL authorization is unavailable.');
      if (result.kind === 'request') {
        setUrlAuth({ ...pending, request: result });
        return;
      }
      setUrlAuth(undefined);
      openUrl(
        result.kind === 'accepted' ? (result.url ?? pending.fallbackUrl) : pending.fallbackUrl,
      );
      options.dismissSingleUseKeyboard(pending.owner);
    } catch {
      if (isCurrent(pending.peer.id, pending.generation)) {
        showNotice('Telegram could not complete this sign-in request.');
      }
    } finally {
      if (isCurrent(pending.peer.id, pending.generation)) setUrlAuthBusy(false);
    }
  };

  onCleanup(() => {
    if (noticeTimer) clearTimeout(noticeTimer);
  });

  return {
    commands,
    commandsLoading,
    menuOpen,
    starting,
    buttonBusy,
    notice,
    urlAuth,
    urlAuthBusy,
    inlineSwitch,
    toggleMenu,
    closeMenu: () => setMenuOpen(false),
    start,
    sendCommand,
    press,
    chooseInlineChat,
    acceptUrlAuth,
    closeInlineSwitch: () => setInlineSwitch(undefined),
    closeUrlAuth: () => {
      if (!urlAuthBusy()) setUrlAuth(undefined);
    },
  };
}
