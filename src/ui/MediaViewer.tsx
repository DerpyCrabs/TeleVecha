import X from 'lucide-solid/icons/x';
import { Portal } from 'solid-js/web';

import { useModalDialog } from './useModalDialog';

export function MediaViewer(props: {
  kind: 'image' | 'video';
  name: string;
  url: string;
  close: () => void;
}) {
  let dialog: HTMLDivElement | undefined;
  useModalDialog(() => dialog, props.close);
  return (
    <Portal>
      <div
        ref={(element) => (dialog = element)}
        class="media-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={`Media preview: ${props.name}`}
        tabIndex={-1}
        onPointerDown={(event) => event.target === event.currentTarget && props.close()}
      >
        <header>
          <span>{props.name}</span>
          <button autofocus onClick={props.close} aria-label="Close media preview">
            <X size={22} />
          </button>
        </header>
        <div class="media-viewer-content">
          {props.kind === 'image' ? (
            <img src={props.url} alt={props.name} />
          ) : (
            <video
              src={props.url}
              controls
              playsinline
              preload="metadata"
              aria-label={props.name}
            />
          )}
        </div>
      </div>
    </Portal>
  );
}
