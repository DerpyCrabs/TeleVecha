import { list } from 'effectweb';
import type { TelegramBotButton, TelegramBotKeyboard } from '../../telegram/types';
import { sequence, view } from 'effectweb';
interface BotKeyboardProps {
  keyboard: TelegramBotKeyboard;
  disabled?: boolean | undefined;
  busyButton?: string | undefined;
  label: string;
  onPress: (button: TelegramBotButton, key: string) => void;
}
export const BotKeyboard = view<BotKeyboardProps, never>((props, _send) => {
  return (
    <div
      class={`bot-keyboard bot-keyboard-${props.keyboard.kind}`}
      role="group"
      aria-label={props.label}
      data-testid={`${props.keyboard.kind}-bot-keyboard`}
    >
      {list(sequence(props.keyboard.rows), (row, rowIndex) => (
        <div class="bot-keyboard-row">
          {list(sequence(row), (button, buttonIndex) => {
            const key = () => `${rowIndex}:${buttonIndex}`;
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
          })}
        </div>
      ))}
    </div>
  );
});
