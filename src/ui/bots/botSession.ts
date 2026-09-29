import type { Snapshot } from 'effectweb';
import { lifetime, available, program } from 'effectweb';
import type { SessionContext } from '../app/sessionContext';
import { Context, Effect } from 'effect';
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
import type { UiEffectRunner, UiTaskRunner } from '../app/appRuntime';
import { subscribeAtUi } from '../app/appRuntime';
import { safeExternalUrl } from '../shared/safeUrl';
import { observeQuery, query } from '@effectweb/query';
export interface BotCommandSource {
  getBotCommands(peer: TelegramPeer): Effect.Effect<TelegramBotCommand[], MessagingError>;
}
export const BotCommandSource = Context.Service<BotCommandSource>('ui/BotCommandSource');
const botCommandsQuery = query({
  name: 'bot-commands',
  load: (peer: TelegramPeer) =>
    Effect.flatMap(BotCommandSource, (source) => source.getBotCommands(peer)),
});
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
  conversation: () => EffectConversation | undefined;
  runEffect: UiEffectRunner;
  runTask: UiTaskRunner;
  snapshot: () => Snapshot<EngineSnapshot>;
  activePeerId: () => string;
  activeDialog: () => TelegramDialog | undefined;
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
export function createBotSession(
  options: BotSessionOptions,
  context: SessionContext<BotCommandSource>,
) {
  const scope = lifetime();
  type BotSessionModel = {
    commandsRequested: string;
    menuOpen: boolean;
    starting: boolean;
    buttonBusy: { owner: string; key: string } | undefined;
    notice: string;
    urlAuth: PendingBotUrlAuth | undefined;
    urlAuthBusy: boolean;
    inlineSwitch: PendingInlineSwitch | undefined;
  };
  type BotSessionMessage =
    | { type: 'CommandsRequested'; value: string }
    | { type: 'MenuOpen'; value: boolean }
    | { type: 'Starting'; value: boolean }
    | { type: 'ButtonBusy'; value: { owner: string; key: string } | undefined }
    | { type: 'Notice'; value: string }
    | { type: 'UrlAuth'; value: PendingBotUrlAuth | undefined }
    | { type: 'UrlAuthBusy'; value: boolean }
    | { type: 'InlineSwitch'; value: PendingInlineSwitch | undefined };
  const state = program<BotSessionModel, BotSessionMessage>({
    initial: {
      commandsRequested: '',
      menuOpen: false,
      starting: false,
      buttonBusy: undefined,
      notice: '',
      urlAuth: undefined,
      urlAuthBusy: false,
      inlineSwitch: undefined,
    },
    update: (model, message) => {
      switch (message.type) {
        case 'CommandsRequested':
          return {
            model: Object.is(model.commandsRequested, message.value)
              ? model
              : { ...model, commandsRequested: message.value },
          };
        case 'MenuOpen':
          return {
            model: Object.is(model.menuOpen, message.value)
              ? model
              : { ...model, menuOpen: message.value },
          };
        case 'Starting':
          return {
            model: Object.is(model.starting, message.value)
              ? model
              : { ...model, starting: message.value },
          };
        case 'ButtonBusy':
          return {
            model: Object.is(model.buttonBusy, message.value)
              ? model
              : { ...model, buttonBusy: message.value },
          };
        case 'Notice':
          return {
            model: Object.is(model.notice, message.value)
              ? model
              : { ...model, notice: message.value },
          };
        case 'UrlAuth':
          return {
            model: Object.is(model.urlAuth, message.value)
              ? model
              : { ...model, urlAuth: message.value },
          };
        case 'UrlAuthBusy':
          return {
            model: Object.is(model.urlAuthBusy, message.value)
              ? model
              : { ...model, urlAuthBusy: message.value },
          };
        case 'InlineSwitch':
          return {
            model: Object.is(model.inlineSwitch, message.value)
              ? model
              : { ...model, inlineSwitch: message.value },
          };
      }
    },
  });
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
    state.send({ type: 'Notice', value: message });
    noticeTimer = setTimeout(() => {
      state.send({ type: 'Notice', value: '' });
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
  const commandsResource = observeQuery(scope, context.cache, botCommandsQuery, context.changed);
  const commands = () => available(commandsResource.read()) ?? [];
  const commandsLoading = () => commandsResource.read().waiting;
  const loadCommands = async () => {
    state.send({ type: 'CommandsRequested', value: options.activePeerId() });
  };
  let activeKey: string | undefined;
  const refresh = () => {
    const peerId = options.activePeerId(),
      conversationPeerId = options.conversation()?.peerId ?? '';
    const nextKey = `${peerId}\0${conversationPeerId}`;
    if (nextKey !== activeKey) {
      activeKey = nextKey;
      actionGeneration++;
      state.send({ type: 'CommandsRequested', value: '' });
      state.send({ type: 'MenuOpen', value: false });
      state.send({ type: 'Starting', value: false });
      state.send({ type: 'ButtonBusy', value: undefined });
      state.send({ type: 'Notice', value: '' });
      state.send({ type: 'UrlAuth', value: undefined });
      state.send({ type: 'UrlAuthBusy', value: false });
      state.send({ type: 'InlineSwitch', value: undefined });
      if (noticeTimer) clearTimeout(noticeTimer);
      if (conversationPeerId === peerId && options.activeDialog()?.peer.kind === 'group')
        loadCommands().catch(() => undefined);
    }
    const dialog = options.activeDialog(),
      conversation = dialog && currentConversation(dialog.peer.id);
    const request =
      conversation &&
      (dialog?.peer.kind === 'group' ||
        (dialog?.bot && state.model().commandsRequested === dialog.peer.id))
        ? conversation
        : undefined;
    commandsResource.select(request ? dialog?.peer : undefined);
  };
  scope.add(state.subscribe(refresh));
  scope.add(
    subscribeAtUi(
      options.runTask,
      options.resources.subscribeResources((event) => {
        if (
          event.kind !== 'bot-commands' ||
          (event.peerId !== undefined && event.peerId !== options.activePeerId())
        )
          return;
        context.cache.invalidateQuery(botCommandsQuery);
      }),
    ),
  );
  const toggleMenu = () => {
    const open = !state.model().menuOpen;
    state.send({ type: 'MenuOpen', value: open });
    if (open) void loadCommands().catch(() => undefined);
  };
  const start = async () => {
    const dialog = options.activeDialog();
    if (!dialog?.bot || state.model().starting) return;
    const peerId = dialog.peer.id;
    const generation = actionGeneration;
    state.send({ type: 'Starting', value: true });
    state.send({ type: 'MenuOpen', value: false });
    try {
      const conversation = currentConversation(peerId);
      if (conversation) await options.runEffect(conversation.startBot());
    } finally {
      if (isCurrent(peerId, generation)) state.send({ type: 'Starting', value: false });
    }
  };
  const sendCommand = (command: TelegramBotCommand) => {
    const dialog = options.activeDialog();
    if (!dialog) return;
    state.send({ type: 'MenuOpen', value: false });
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
    if (!dialog || state.model().buttonBusy) return;
    const peer = { ...dialog.peer };
    const peerId = peer.id;
    const generation = actionGeneration;
    state.send({ type: 'ButtonBusy', value: { owner, key } });
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
          state.send({
            type: 'UrlAuth',
            value: {
              peer,
              messageId,
              buttonId: button.buttonId,
              fallbackUrl: button.url,
              request: result,
              generation,
              owner,
            },
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
          ? await options.runEffect(conversation.answerBotCallback(messageId, [...button.data]))
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
            state.send({
              type: 'InlineSwitch',
              value: {
                query: button.query ?? '',
                ...(button.botUsername ? { botUsername: button.botUsername } : {}),
                owner,
              },
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
        state.send({
          type: 'ButtonBusy',
          value: ((current) =>
            current?.owner === owner && current.key === key ? undefined : current)(
            state.model().buttonBusy,
          ),
        });
      }
    }
  };
  const chooseInlineChat = async (peerId: string) => {
    const pending = state.model().inlineSwitch;
    if (!pending) return;
    const prefix = pending.botUsername ? `@${pending.botUsername} ` : '';
    const nextDraft = `${prefix}${pending.query}`;
    options.dismissSingleUseKeyboard(pending.owner);
    state.send({ type: 'InlineSwitch', value: undefined });
    await options.runEffect(options.setPeerDraft(peerId, nextDraft));
    if (!(await options.selectChat(peerId))) return;
    options.setDraft(nextDraft);
    if (options.activePeerId() === peerId) focusComposer();
  };
  const acceptUrlAuth = async (acceptOptions: TelegramUrlAuthAcceptOptions) => {
    const pending = state.model().urlAuth;
    if (!pending || state.model().urlAuthBusy) return;
    state.send({ type: 'UrlAuthBusy', value: true });
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
        state.send({ type: 'UrlAuth', value: { ...pending, request: result } });
        return;
      }
      state.send({ type: 'UrlAuth', value: undefined });
      openUrl(
        result.kind === 'accepted' ? (result.url ?? pending.fallbackUrl) : pending.fallbackUrl,
      );
      options.dismissSingleUseKeyboard(pending.owner);
    } catch {
      if (isCurrent(pending.peer.id, pending.generation)) {
        showNotice('Telegram could not complete this sign-in request.');
      }
    } finally {
      if (isCurrent(pending.peer.id, pending.generation))
        state.send({ type: 'UrlAuthBusy', value: false });
    }
  };
  scope.add(() => {
    if (noticeTimer) clearTimeout(noticeTimer);
  });
  const actions = {
    refresh,
    toggleMenu,
    closeMenu: () => state.send({ type: 'MenuOpen', value: false }),
    start,
    sendCommand,
    press,
    chooseInlineChat,
    acceptUrlAuth,
    closeInlineSwitch: () => state.send({ type: 'InlineSwitch', value: undefined }),
    closeUrlAuth: () => {
      if (!state.model().urlAuthBusy) state.send({ type: 'UrlAuth', value: undefined });
    },
  };
  return {
    ...actions,
    model: state.model,
    subscribe: state.subscribe,
    dispose: () => {
      scope.dispose();
      state.dispose();
    },
    snapshot: () => ({
      ...actions,
      commands: commands(),
      commandsLoading: commandsLoading(),
      menuOpen: state.model().menuOpen,
      starting: state.model().starting,
      buttonBusy: state.model().buttonBusy,
      notice: state.model().notice,
      urlAuth: state.model().urlAuth,
      urlAuthBusy: state.model().urlAuthBusy,
      inlineSwitch: state.model().inlineSwitch,
    }),
  };
}
