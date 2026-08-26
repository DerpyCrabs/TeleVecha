import Command from 'lucide-solid/icons/command';
import RotateCcw from 'lucide-solid/icons/rotate-ccw';
import { For, Show } from 'solid-js';

import type { TelegramBotButton, TelegramBotCommand, TelegramBotKeyboard } from '../telegram/types';
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

export function BotControls(props: BotControlsProps) {
  return (
    <section
      class="bot-controls"
      aria-label={props.isBot ? 'Bot controls' : 'Conversation reply keyboard'}
    >
      <Show when={props.isBot && !props.started}>
        <button
          class="bot-start-button"
          type="button"
          disabled={!props.enabled || props.starting}
          onClick={props.onStart}
        >
          {props.starting ? 'Starting…' : 'Start bot'}
        </button>
      </Show>
      <Show when={props.showCommands && (!props.isBot || props.started)}>
        <div class="bot-command-bar">
          <button
            type="button"
            disabled={!props.enabled || props.starting}
            aria-expanded={props.menuOpen}
            aria-haspopup="menu"
            onClick={props.onToggleMenu}
          >
            <Command size={16} aria-hidden="true" /> Commands
          </button>
          <Show when={props.menuOpen}>
            <div class="bot-command-menu" role="menu" aria-label="Bot commands">
              <Show when={props.isBot}>
                <button
                  role="menuitem"
                  disabled={!props.enabled || props.starting}
                  onClick={props.onStart}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  {props.starting ? 'Restarting…' : 'Restart bot'}
                </button>
              </Show>
              <Show when={props.loadingCommands}>
                <span role="status">Loading commands…</span>
              </Show>
              <For each={props.commands}>
                {(command) => (
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
                )}
              </For>
              <Show when={!props.loadingCommands && props.commands.length === 0}>
                <span>No commands published by this bot.</span>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
      <Show
        when={
          props.replyKeyboard?.hidden || !props.replyKeyboard?.rows.some((row) => row.length > 0)
            ? undefined
            : props.replyKeyboard
        }
      >
        {(keyboard) => (
          <BotKeyboard
            keyboard={keyboard()}
            disabled={!props.enabled}
            busyButton={props.busyButton}
            label="Bot reply keyboard"
            onPress={props.onReplyButton}
          />
        )}
      </Show>
    </section>
  );
}
