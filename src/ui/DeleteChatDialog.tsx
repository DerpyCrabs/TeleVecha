import X from 'lucide-solid/icons/x';
import { Portal } from 'solid-js/web';

import type { ChatSummary } from '../domain/models';
import { useModalDialog } from './useModalDialog';

export function DeleteChatDialog(props: {
  chat: ChatSummary;
  close: () => void;
  confirm: () => void;
}) {
  let overlay: HTMLDivElement | undefined;
  useModalDialog(() => overlay, props.close);
  const action = () =>
    props.chat.kind === 'user'
      ? 'Delete chat'
      : props.chat.kind === 'channel'
        ? 'Leave channel'
        : 'Leave group';
  return (
    <Portal>
      <div
        ref={(element) => (overlay = element)}
        class="panel-overlay"
        role="presentation"
        tabIndex={-1}
        onPointerDown={(event) => event.target === event.currentTarget && props.close()}
      >
        <section class="delete-dialog" role="dialog" aria-modal="true" aria-label={action()}>
          <header>
            <strong>{action()}</strong>
            <button onClick={props.close} aria-label="Cancel">
              <X size={18} />
            </button>
          </header>
          <p>
            {props.chat.kind === 'user'
              ? `Delete your chat history with ${props.chat.title}?`
              : `You will leave ${props.chat.title} and remove it from the chat list.`}
          </p>
          <button class="danger" onClick={props.confirm}>
            {action()}
          </button>
        </section>
      </div>
    </Portal>
  );
}
