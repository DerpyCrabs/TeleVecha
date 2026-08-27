import ChevronLeft from 'lucide-solid/icons/chevron-left';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import X from 'lucide-solid/icons/x';
import { Show } from 'solid-js';
import { Portal } from 'solid-js/web';

import { useModalDialog } from '../shared/useModalDialog';

function mediaDimensions(element: HTMLImageElement | HTMLVideoElement) {
  return element instanceof HTMLImageElement
    ? { width: element.naturalWidth, height: element.naturalHeight }
    : { width: element.videoWidth, height: element.videoHeight };
}

export function MediaViewer(props: {
  kind: 'image' | 'video';
  name: string;
  url: string;
  close: () => void;
  position?: number | undefined;
  count?: number | undefined;
  loading?: boolean | undefined;
  previous?: (() => void) | undefined;
  next?: (() => void) | undefined;
}) {
  let dialog: HTMLDivElement | undefined;
  useModalDialog(() => dialog, props.close);
  const closeOutsideMedia = (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
    const target = event.target;
    if (target === event.currentTarget) {
      props.close();
      return;
    }
    if (!(target instanceof HTMLImageElement || target instanceof HTMLVideoElement)) return;
    const dimensions = mediaDimensions(target);
    if (!dimensions.width || !dimensions.height) return;
    const bounds = target.getBoundingClientRect();
    const scale = Math.min(bounds.width / dimensions.width, bounds.height / dimensions.height);
    const renderedWidth = dimensions.width * scale;
    const renderedHeight = dimensions.height * scale;
    const left = bounds.left + (bounds.width - renderedWidth) / 2;
    const top = bounds.top + (bounds.height - renderedHeight) / 2;
    if (
      event.clientX < left ||
      event.clientX > left + renderedWidth ||
      event.clientY < top ||
      event.clientY > top + renderedHeight
    ) {
      props.close();
    }
  };
  const navigateWithKeyboard = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLVideoElement) return;
    const navigate =
      event.key === 'ArrowLeft'
        ? props.previous
        : event.key === 'ArrowRight'
          ? props.next
          : undefined;
    if (!navigate || props.loading) return;
    event.preventDefault();
    navigate();
  };
  return (
    <Portal>
      <div
        ref={(element) => (dialog = element)}
        class="media-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={`Media preview: ${props.name}`}
        tabIndex={-1}
        onKeyDown={navigateWithKeyboard}
      >
        <header>
          <div class="media-viewer-title">
            <span>{props.name}</span>
            <Show when={(props.count ?? 0) > 1}>
              <small aria-label={`Attachment ${props.position} of ${props.count}`}>
                {props.position} / {props.count}
              </small>
            </Show>
          </div>
          <button autofocus onClick={props.close} aria-label="Close media preview">
            <X size={22} />
          </button>
        </header>
        <div class="media-viewer-content" onClick={closeOutsideMedia}>
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
          <Show when={(props.count ?? 0) > 1}>
            <button
              class="media-viewer-navigation previous"
              onClick={() => !props.loading && props.previous?.()}
              aria-disabled={!props.previous || props.loading}
              aria-label="Previous attachment"
            >
              <ChevronLeft size={28} />
            </button>
            <button
              class="media-viewer-navigation next"
              onClick={() => !props.loading && props.next?.()}
              aria-disabled={!props.next || props.loading}
              aria-label="Next attachment"
            >
              <ChevronRight size={28} />
            </button>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
