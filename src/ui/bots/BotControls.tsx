import { ToggleMenu } from '../shared/menuSurface';
import { list } from 'effectweb';
import type { TelegramBotCommand } from '../../telegram/types';
import { commandRows } from '../collections';

import RotateCcw from '@effectweb/lucide/icons/rotate-ccw';
import { view, domBinding } from 'effectweb';

export interface BotControlsProps {
  isBot: boolean;
  appTitle?: string | undefined;
  appBusy: boolean;
  onOpenApp: () => void;
  showCommands: boolean;
  started: boolean;
  enabled: boolean;
  starting: boolean;
  menuOpen: boolean;
  loadingCommands: boolean;
  commands: TelegramBotCommand[];
  query?: string | undefined;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onStart: () => void;
  onCommand: (command: TelegramBotCommand) => void;
}
function bindBotMenu(element: HTMLElement, read: () => BotControlsProps) {
  const outside = (event: PointerEvent) => {
    if (read().menuOpen && event.target instanceof Node && !element.contains(event.target))
      read().onCloseMenu();
  };
  const keyboard = (event: KeyboardEvent) => {
    if (!read().menuOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      read().onCloseMenu();
      element.querySelector<HTMLButtonElement>('.bot-command-bar > button')?.focus();
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const items = [
        ...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
      ];
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[index]?.focus();
    }
  };
  document.addEventListener('pointerdown', outside);
  element.addEventListener('keydown', keyboard);
  return () => {
    document.removeEventListener('pointerdown', outside);
    element.removeEventListener('keydown', keyboard);
  };
}
export const BotControls = view<BotControlsProps, never>((props, _send) => {
  return (
    <section
      class="bot-controls"
      use={domBinding(props, bindBotMenu)}
      aria-label={props.isBot ? 'Bot controls' : 'Conversation reply keyboard'}
    >
      {props.isBot && (!props.started || props.starting) ? (
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
            title="Bot commands"
            aria-expanded={props.menuOpen}
            aria-haspopup="menu"
            onClick={props.onToggleMenu}
          >
            Menu
          </button>
          <ToggleMenu
            value={props.menuOpen || undefined}
            render={(_, closing) => (
              <div
                class="menu-surface bot-command-menu"
                inert={closing}
                aria-hidden={closing || undefined}
                role="menu"
                aria-label="Bot commands"
              >
                {props.appTitle && !props.query ? (
                  <button
                    class="bot-open-app"
                    role="menuitem"
                    disabled={!props.enabled || props.appBusy}
                    onClick={() => {
                      props.onCloseMenu();
                      props.onOpenApp();
                    }}
                  >
                    {props.appBusy ? 'Opening…' : props.appTitle}
                  </button>
                ) : null}
                {props.isBot && !props.query ? (
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
                {list(
                  commandRows(
                    props.commands.filter(
                      (command) =>
                        !props.query ||
                        `/${command.command}${command.botUsername ? `@${command.botUsername}` : ''}`
                          .toLowerCase()
                          .startsWith(props.query.toLowerCase()),
                    ),
                  ),
                  (command) => (
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
                  ),
                )}
                {!props.loadingCommands && props.commands.length === 0 ? (
                  <span>No commands published by this bot.</span>
                ) : null}
              </div>
            )}
          />
        </div>
      ) : null}
    </section>
  );
});
