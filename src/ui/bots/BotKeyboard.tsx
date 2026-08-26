import { For } from 'solid-js';

import type { TelegramBotButton, TelegramBotKeyboard } from '../../telegram/types';

interface BotKeyboardProps {
  keyboard: TelegramBotKeyboard;
  disabled?: boolean | undefined;
  busyButton?: string | undefined;
  label: string;
  onPress: (button: TelegramBotButton, key: string) => void;
}

export function BotKeyboard(props: BotKeyboardProps) {
  return (
    <div
      class={`bot-keyboard bot-keyboard-${props.keyboard.kind}`}
      role="group"
      aria-label={props.label}
      data-testid={`${props.keyboard.kind}-bot-keyboard`}
    >
      <For each={props.keyboard.rows}>
        {(row, rowIndex) => (
          <div class="bot-keyboard-row">
            <For each={row}>
              {(button, buttonIndex) => {
                const key = () => `${rowIndex()}:${buttonIndex()}`;
                return (
                  <button
                    type="button"
                    disabled={
                      props.disabled || Boolean(props.busyButton) || button.kind === 'unsupported'
                    }
                    aria-busy={props.busyButton === key()}
                    title={
                      button.kind === 'unsupported'
                        ? 'This Telegram button type is not supported.'
                        : undefined
                    }
                    onClick={() => props.onPress(button, key())}
                  >
                    {props.busyButton === key() ? 'Working…' : button.text}
                  </button>
                );
              }}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}
