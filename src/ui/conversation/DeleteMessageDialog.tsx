import { view } from 'effectweb';
import { Dialog } from '../shared/Dialog';
export const DeleteMessageDialog = view<
  {
    canDeleteForMe: boolean;
    canDeleteForEveryone: boolean;
    close: () => void;
    confirm: (revoke: boolean) => void;
  },
  never
>((props, _send) => {
  return (
    <Dialog
      title="Delete message"
      onClose={props.close}
      closeLabel="Cancel deletion"
      class="delete-dialog flex w-[min(22rem,calc(100vw-2rem))] max-h-[min(42rem,calc(100dvh-2rem))] flex-col overflow-hidden rounded-2xl border border-[var(--line-strong)] bg-panel pb-[0.7rem] shadow-[0_24px_80px_var(--shadow)]"
    >
      <p class="m-0 px-4 py-[0.8rem] text-[0.8rem] text-muted">This cannot be undone.</p>
      {props.canDeleteForMe ? (
        <button
          class="mx-[0.7rem] my-[0.2rem] rounded-[0.6rem] border-0 bg-[#20232a] p-[0.7rem] text-ink"
          onClick={() => props.confirm(false)}
        >
          Delete for me
        </button>
      ) : null}
      {props.canDeleteForEveryone ? (
        <button
          class="danger mx-[0.7rem] my-[0.2rem] rounded-[0.6rem] border-0 bg-[#20232a] p-[0.7rem] text-red-300"
          onClick={() => props.confirm(true)}
        >
          Delete for everyone
        </button>
      ) : null}
    </Dialog>
  );
});
