import X from 'lucide-solid/icons/x';
import { For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';

import { deleteDialogOptions } from '../../telegram/core/chatPermissions';
import type { TelegramDeleteDialogAction, TelegramDialog } from '../../telegram/types';
import { panelCloseButtonClass, panelHeaderClass } from '../shared/panelStyles';
import { useModalDialog } from '../shared/useModalDialog';

export function DeleteChatDialog(props: {
  dialog: TelegramDialog;
  close: () => void;
  confirm: (action: TelegramDeleteDialogAction) => void;
  hasDraft: boolean;
  queuedCount: number;
}) {
  let overlay: HTMLDivElement | undefined;
  useModalDialog(() => overlay, props.close);
  const options = () => deleteDialogOptions(props.dialog);
  const title = () =>
    props.dialog.peer.kind === 'user' ? 'Delete chat' : (options()[0]?.label ?? 'Chat action');
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
          aria-label={title()}
        >
          <header class={panelHeaderClass}>
            <strong>{title()}</strong>
            <button class={panelCloseButtonClass} onClick={props.close} aria-label="Cancel">
              <X size={18} />
            </button>
          </header>
          <p class="m-0 px-4 py-[0.8rem] text-[0.8rem] text-muted">
            {props.dialog.peer.kind === 'user'
              ? `Delete your chat history with ${props.dialog.title}?`
              : `Choose how to handle ${props.dialog.title}.`}
            <Show when={props.hasDraft || props.queuedCount > 0}>
              {' '}
              {props.hasDraft && props.queuedCount > 0
                ? 'This also removes your draft and cancels queued messages.'
                : props.hasDraft
                  ? 'This also removes your draft.'
                  : 'This also cancels queued messages.'}
            </Show>
          </p>
          <div class="grid gap-1 px-[0.7rem]">
            <For each={options()}>
              {(option) => (
                <button
                  class={`mx-0 my-[0.2rem] rounded-[0.6rem] border-0 bg-[#20232a] p-[0.7rem] text-left ${option.danger ? 'text-red-300' : 'text-ink'}`}
                  onClick={() => props.confirm(option.action)}
                  aria-label={option.label}
                >
                  <strong class="block">{option.label}</strong>
                  <small class="mt-1 block text-[0.72rem] text-muted">{option.description}</small>
                </button>
              )}
            </For>
          </div>
        </section>
      </div>
    </Portal>
  );
}
