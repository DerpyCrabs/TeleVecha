import X from 'lucide-solid/icons/x';
import { For } from 'solid-js';
import { Portal } from 'solid-js/web';

import type { ChatSummary } from '../domain/models';
import { useModalDialog } from './useModalDialog';

export function ForwardMessageDialog(props: {
  chats: ChatSummary[];
  close: () => void;
  forward: (peerId: string) => void;
  title?: string | undefined;
  label?: string | undefined;
  cancelLabel?: string | undefined;
}) {
  let overlay: HTMLDivElement | undefined;
  useModalDialog(() => overlay, props.close);

  return (
    <Portal>
      <div
        ref={(element) => (overlay = element)}
        class="forward-overlay"
        role="presentation"
        tabIndex={-1}
        onPointerDown={(event) => event.target === event.currentTarget && props.close()}
      >
        <div
          class="forward-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={props.label ?? 'Forward message'}
        >
          <header>
            <strong>{props.title ?? 'Forward to'}</strong>
            <button onClick={props.close} aria-label={props.cancelLabel ?? 'Cancel forward'}>
              <X size={17} />
            </button>
          </header>
          <div>
            <For each={props.chats}>
              {(chat) => <button onClick={() => props.forward(chat.id)}>{chat.title}</button>}
            </For>
          </div>
        </div>
      </div>
    </Portal>
  );
}
