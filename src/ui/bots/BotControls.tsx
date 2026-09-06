import type {
  TelegramBotButton,
  TelegramBotCommand,
  TelegramBotKeyboard,
} from '../../telegram/types';
import { commandRows } from '../collections';
import Command from '@effectweb/lucide/icons/command';
import RotateCcw from '@effectweb/lucide/icons/rotate-ccw';
import { view } from 'effectweb';
import { BotKeyboard } from './BotKeyboard';
interface BotControlsProps {
  isBot: boolean;
  showCommands: boolean;
  started: boolean;
  enabled: boolean;
  starting: boolean;
  menuOpen: boolean;
  loadingCommands: boolean;
  commands: TelegramBotCommand[];
  replyKeyboard?: TelegramBotKeyboard | undefined;
  busyButton?: string | undefined;
  onToggleMenu: () => void;
  onStart: () => void;
  onCommand: (command: TelegramBotCommand) => void;
  onReplyButton: (button: TelegramBotButton, key: string) => void;
}
export const BotControls = view<BotControlsProps, never>((props, _send) => {
  return (
    <section
      class="bot-controls"
      aria-label={props.isBot ? 'Bot controls' : 'Conversation reply keyboard'}
    >
      {props.isBot && !props.started ? (
        <button
          class="bot-start-button"
          type="button"
          disabled={!props.enabled || props.starting}
          onClick={props.onStart}
        >
          {props.starting ? 'Starting…' : 'Start bot'}
        </button>
      ) : null}
      {props.showCommands && (!props.isBot || props.started) ? (
        <div class="bot-command-bar">
          <button
            type="button"
            disabled={props.starting}
            aria-expanded={props.menuOpen}
            aria-haspopup="menu"
            onClick={props.onToggleMenu}
          >
            <Command size={16} aria-hidden="true" /> Commands
          </button>
          {props.menuOpen ? (
            <div class="bot-command-menu" role="menu" aria-label="Bot commands">
              {props.isBot ? (
                <button
                  role="menuitem"
                  disabled={!props.enabled || props.starting}
                  onClick={props.onStart}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  {props.starting ? 'Restarting…' : 'Restart bot'}
                </button>
              ) : null}
              {props.loadingCommands ? <span role="status">Loading commands…</span> : null}
              {commandRows(props.commands).map((command) => (
                <button
                  role="menuitem"
                  disabled={!props.enabled}
                  onClick={() => props.onCommand(command)}
                >
                  <strong>
                    /{command.command}
                    {!props.isBot && command.botUsername ? `@${command.botUsername}` : ''}
                  </strong>
                  <small>
                    {!props.isBot && command.botName ? `${command.botName} · ` : ''}
                    {command.description}
                  </small>
                </button>
              ))}
              {!props.loadingCommands && props.commands.length === 0 ? (
                <span>No commands published by this bot.</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {(
        props.replyKeyboard?.hidden || !props.replyKeyboard?.rows.some((row) => row.length > 0)
          ? undefined
          : props.replyKeyboard
      )
        ? ((keyboard) => (
            <BotKeyboard
              keyboard={keyboard}
              disabled={!props.enabled}
              busyButton={props.busyButton}
              label="Bot reply keyboard"
              onPress={props.onReplyButton}
            />
          ))(
            (props.replyKeyboard?.hidden || !props.replyKeyboard?.rows.some((row) => row.length > 0)
              ? undefined
              : props.replyKeyboard)!,
          )
        : null}
    </section>
  );
});
