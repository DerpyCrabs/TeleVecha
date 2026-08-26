import X from 'lucide-solid/icons/x';
import { Portal } from 'solid-js/web';

import { useModalDialog } from './useModalDialog';

export function DeleteMessageDialog(props: {
  outgoing: boolean;
  close: () => void;
  confirm: (revoke: boolean) => void;
}) {
  let overlay: HTMLDivElement | undefined;
  useModalDialog(() => overlay, props.close);
  return (
    <Portal>
      <div
        ref={(element) => (overlay = element)}
        class="panel-overlay"
        role="presentation"
        tabIndex={-1}
        onPointerDown={(event) => event.target === event.currentTarget && props.close()}
      >
        <section class="delete-dialog" role="dialog" aria-modal="true" aria-label="Delete message">
          <header>
            <strong>Delete message</strong>
            <button onClick={props.close} aria-label="Cancel deletion">
              <X size={18} />
            </button>
          </header>
          <p>This cannot be undone.</p>
          <button onClick={() => props.confirm(false)}>Delete for me</button>
          <button class="danger" onClick={() => props.confirm(true)}>
            {props.outgoing ? 'Delete for everyone' : 'Delete for both sides'}
          </button>
        </section>
      </div>
    </Portal>
  );
}
