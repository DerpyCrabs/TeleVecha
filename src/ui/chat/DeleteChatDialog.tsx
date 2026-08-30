import X from 'lucide-solid/icons/x';
import { Show } from 'solid-js';
import { Portal } from 'solid-js/web';

import type { ChatSummary } from '../../domain/models';
import { panelCloseButtonClass, panelHeaderClass } from '../shared/panelStyles';
import { useModalDialog } from '../shared/useModalDialog';

export function DeleteChatDialog(props: {
  chat: ChatSummary;
  close: () => void;
  confirm: () => void;
  hasDraft: boolean;
  queuedCount: number;
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
        <section
          class="delete-dialog flex w-[min(22rem,calc(100vw-2rem))] max-h-[min(42rem,calc(100dvh-2rem))] flex-col overflow-hidden rounded-2xl border border-[var(--line-strong)] bg-panel pb-[0.7rem] shadow-[0_24px_80px_var(--shadow)]"
          role="dialog"
          aria-modal="true"
          aria-label={action()}
        >
          <header class={panelHeaderClass}>
            <strong>{action()}</strong>
            <button class={panelCloseButtonClass} onClick={props.close} aria-label="Cancel">
              <X size={18} />
            </button>
          </header>
          <p class="m-0 px-4 py-[0.8rem] text-[0.8rem] text-muted">
            {props.chat.kind === 'user'
              ? `Delete your chat history with ${props.chat.title}?`
              : `You will leave ${props.chat.title} and remove it from the chat list.`}
            <Show when={props.hasDraft || props.queuedCount > 0}>
              {' '}
              {props.hasDraft && props.queuedCount > 0
                ? 'This also removes your draft and cancels queued messages.'
                : props.hasDraft
                  ? 'This also removes your draft.'
                  : 'This also cancels queued messages.'}
            </Show>
          </p>
          <button
            class="danger mx-[0.7rem] my-[0.2rem] rounded-[0.6rem] border-0 bg-[#20232a] p-[0.7rem] text-red-300"
            onClick={props.confirm}
          >
            {action()}
          </button>
        </section>
      </div>
    </Portal>
  );
}
