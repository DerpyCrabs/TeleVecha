import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';

import type { MessagingEngine } from '../../telegram/core/engine';
import type {
  EngineSnapshot,
  TelegramBotButton,
  TelegramBotCommand,
  TelegramDialog,
  TelegramPeer,
  TelegramUrlAuthAcceptOptions,
  TelegramUrlAuthResult,
} from '../../telegram/types';
import { safeExternalUrl } from '../shared/safeUrl';

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
  engine: MessagingEngine;
  snapshot: Accessor<EngineSnapshot>;
  activePeerId: Accessor<string>;
  activeDialog: Accessor<TelegramDialog | undefined>;
  selectChat: (peerId: string) => Promise<boolean>;
  setDraft: (value: string) => void;
  dismissSingleUseKeyboard: (owner: string) => void;
  focusComposer: () => void;
}

export function createBotSession(options: BotSessionOptions) {
  const [commands, setCommands] = createSignal<TelegramBotCommand[]>([]);
  const [commandsPeerId, setCommandsPeerId] = createSignal('');
  const [commandsLoading, setCommandsLoading] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [buttonBusy, setButtonBusy] = createSignal<{ owner: string; key: string }>();
  const [notice, setNotice] = createSignal('');
  const [urlAuth, setUrlAuth] = createSignal<PendingBotUrlAuth>();
  const [urlAuthBusy, setUrlAuthBusy] = createSignal(false);
  const [inlineSwitch, setInlineSwitch] = createSignal<PendingInlineSwitch>();
  let actionGeneration = 0;
  let commandsGeneration = 0;
  let uiPeerId = '';
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  const isCurrent = (peerId: string, generation: number) =>
    options.activePeerId() === peerId && actionGeneration === generation;
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

  const loadCommands = async () => {
    const dialog = options.activeDialog();
    const supportsCommands = dialog?.bot || dialog?.peer.kind === 'group';
    if (!dialog || !supportsCommands || commandsLoading() || commandsPeerId() === dialog.peer.id) {
      return;
    }
    const peerId = dialog.peer.id;
    const generation = ++commandsGeneration;
    setCommandsLoading(true);
    try {
      const next = await options.engine.getBotCommands(dialog.peer);
      if (options.activePeerId() !== peerId || generation !== commandsGeneration) return;
      setCommands(next);
      setCommandsPeerId(peerId);
    } finally {
      if (options.activePeerId() === peerId && generation === commandsGeneration) {
        setCommandsLoading(false);
      }
    }
  };

  createEffect(() => {
    const peerId = options.activePeerId();
    if (uiPeerId === peerId) return;
    uiPeerId = peerId;
    actionGeneration += 1;
    commandsGeneration += 1;
    setCommands([]);
    setCommandsPeerId('');
    setCommandsLoading(false);
    setMenuOpen(false);
    setStarting(false);
    setButtonBusy(undefined);
    setNotice('');
    setUrlAuth(undefined);
    setUrlAuthBusy(false);
    setInlineSwitch(undefined);
    if (noticeTimer) clearTimeout(noticeTimer);
  });

  let observedCommandsRevision = options.snapshot().botCommandsRevision;
  createEffect(() => {
    const revision = options.snapshot().botCommandsRevision;
    if (revision === observedCommandsRevision) return;
    observedCommandsRevision = revision;
    const hadLoadedCommands = commandsPeerId() === options.activePeerId();
    commandsGeneration += 1;
    setCommands([]);
    setCommandsPeerId('');
    setCommandsLoading(false);
    const dialog = options.activeDialog();
    if ((dialog?.bot || dialog?.peer.kind === 'group') && (hadLoadedCommands || menuOpen())) {
      void loadCommands().catch(() => undefined);
    }
  });

  const toggleMenu = () => {
    const open = !menuOpen();
    setMenuOpen(open);
    if (open) void loadCommands().catch(() => undefined);
  };
  const start = async () => {
    const dialog = options.activeDialog();
    if (!dialog?.bot || starting()) return;
    const peerId = dialog.peer.id;
    setStarting(true);
    setMenuOpen(false);
    try {
      await options.engine.startBot(dialog.peer);
    } finally {
      if (options.activePeerId() === peerId) setStarting(false);
    }
  };
  const sendCommand = (command: TelegramBotCommand) => {
    const dialog = options.activeDialog();
    if (!dialog) return;
    setMenuOpen(false);
    const suffix = dialog.bot || !command.botUsername ? '' : `@${command.botUsername}`;
    void options.engine
      .sendDraft(dialog.peer, `/${command.command}${suffix}`)
      .catch(() => undefined);
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
        await options.engine.sendDraft(peer, button.text);
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
        const result = await options.engine.requestUrlAuth(peer, messageId, button.buttonId);
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
        const answer = await options.engine.answerBotCallback(peer, messageId, button.data);
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
        await options.engine.setDraft(peerId, nextDraft);
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
    options.dismissSingleUseKeyboard(pending.owner);
    setInlineSwitch(undefined);
    if (!(await options.selectChat(peerId))) return;
    const prefix = pending.botUsername ? `@${pending.botUsername} ` : '';
    const nextDraft = `${prefix}${pending.query}`;
    options.setDraft(nextDraft);
    await options.engine.setDraft(peerId, nextDraft);
    if (options.activePeerId() === peerId) focusComposer();
  };

  const acceptUrlAuth = async (acceptOptions: TelegramUrlAuthAcceptOptions) => {
    const pending = urlAuth();
    if (!pending || urlAuthBusy()) return;
    setUrlAuthBusy(true);
    try {
      const result = await options.engine.acceptUrlAuth(
        pending.peer,
        pending.messageId,
        pending.buttonId,
        acceptOptions,
      );
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
