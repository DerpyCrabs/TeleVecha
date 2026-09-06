import { deleteDialogOptions } from '../../telegram/core/chatPermissions';
import type { TelegramDeleteDialogAction, TelegramDialog } from '../../telegram/types';
import { sequence, view } from 'effectweb';
import { Dialog } from '../shared/Dialog';
export const DeleteChatDialog = view<
  {
    dialog: TelegramDialog;
    close: () => void;
    confirm: (action: TelegramDeleteDialogAction) => void;
    hasDraft: boolean;
    queuedCount: number;
  },
  never
>((props, _send) => {
  const options = () => deleteDialogOptions(props.dialog);
  const title = () =>
    props.dialog.peer.kind === 'user' ? 'Delete chat' : (options()[0]?.label ?? 'Chat action');
  return (
    <Dialog
      title={title()}
      onClose={props.close}
      closeLabel="Cancel"
      class="delete-dialog flex w-[min(22rem,calc(100vw-2rem))] max-h-[min(42rem,calc(100dvh-2rem))] flex-col overflow-hidden rounded-2xl border border-[var(--line-strong)] bg-panel pb-[0.7rem] shadow-[0_24px_80px_var(--shadow)]"
    >
      <p class="m-0 px-4 py-[0.8rem] text-[0.8rem] text-muted">
        {props.dialog.peer.kind === 'user'
          ? `Delete your chat history with ${props.dialog.title}?`
          : `Choose how to handle ${props.dialog.title}.`}
        {props.hasDraft || props.queuedCount > 0 ? (
          <>
            {' '}
            {props.hasDraft && props.queuedCount > 0
              ? 'This also removes your draft and cancels queued messages.'
              : props.hasDraft
                ? 'This also removes your draft.'
                : 'This also cancels queued messages.'}
          </>
        ) : null}
      </p>
      <div class="grid gap-1 px-[0.7rem]">
        {sequence(options()).map((option) => (
          <button
            class={`mx-0 my-[0.2rem] rounded-[0.6rem] border-0 bg-[#20232a] p-[0.7rem] text-left ${option.danger ? 'text-red-300' : 'text-ink'}`}
            onClick={() => props.confirm(option.action)}
            aria-label={option.label}
          >
            <strong class="block">{option.label}</strong>
            <small class="mt-1 block text-[0.72rem] text-muted">{option.description}</small>
          </button>
        ))}
      </div>
    </Dialog>
  );
});
