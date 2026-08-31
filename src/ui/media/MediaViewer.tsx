import ChevronLeft from 'lucide-solid/icons/chevron-left';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import Copy from 'lucide-solid/icons/copy';
import Download from 'lucide-solid/icons/download';
import ExternalLink from 'lucide-solid/icons/external-link';
import Forward from 'lucide-solid/icons/forward';
import Pencil from 'lucide-solid/icons/pencil';
import Trash2 from 'lucide-solid/icons/trash-2';
import X from 'lucide-solid/icons/x';
import { Show, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';

import { useModalDialog } from '../shared/useModalDialog';
import { copyImageUrl, saveMediaUrl } from './mediaActions';

function mediaDimensions(element: HTMLImageElement | HTMLVideoElement) {
  return element instanceof HTMLImageElement
    ? { width: element.naturalWidth, height: element.naturalHeight }
    : { width: element.videoWidth, height: element.videoHeight };
}

export interface MediaViewerProps {
  kind: 'image' | 'video';
  name: string;
  url: string;
  close: () => void;
  author?: string | undefined;
  time?: string | undefined;
  caption?: string | undefined;
  protected?: boolean | undefined;
  origin?: DOMRect | undefined;
  position?: number | undefined;
  count?: number | undefined;
  loading?: boolean | undefined;
  previous?: (() => void) | undefined;
  next?: (() => void) | undefined;
  download?: (() => void) | undefined;
  forward?: (() => void) | undefined;
  edit?: (() => void) | undefined;
  delete?: (() => void) | undefined;
  goToMessage?: (() => void) | undefined;
}

export function MediaViewer(props: MediaViewerProps) {
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [menu, setMenu] = createSignal<{ x: number; y: number }>();
  let dialog: HTMLDivElement | undefined;
  let drag:
    | { pointerId: number; startX: number; startY: number; panX: number; panY: number }
    | undefined;
  useModalDialog(() => dialog, props.close);

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const setZoomLevel = (value: number) => {
    const next = Math.max(1, Math.min(4, value));
    setZoom(next);
    if (next === 1) setPan({ x: 0, y: 0 });
  };
  const closeOutsideMedia = (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
    if (zoom() > 1) return;
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
    resetView();
    navigate();
  };
  const openContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY });
  };
  const download = () => (props.download ? props.download() : saveMediaUrl(props.url, props.name));
  const canExport = () => !props.protected;
  const originStyle = () => {
    const origin = props.origin;
    if (!origin) return {};
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const scale = Math.max(
      0.05,
      Math.min(1, origin.width / viewportWidth, origin.height / viewportHeight),
    );
    return {
      '--media-origin-x': `${origin.left + origin.width / 2 - viewportWidth / 2}px`,
      '--media-origin-y': `${origin.top + origin.height / 2 - viewportHeight / 2}px`,
      '--media-origin-scale': String(scale),
    };
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
        onPointerDown={() => setMenu(undefined)}
      >
        <header>
          <div class="media-viewer-title">
            <strong>{props.author || props.name}</strong>
            <Show when={props.author && props.time}>
              <small>{props.time}</small>
            </Show>
            <Show when={(props.count ?? 0) > 1}>
              <small aria-label={`Attachment ${props.position} of ${props.count}`}>
                {props.position} / {props.count}
              </small>
            </Show>
          </div>
          <div class="media-viewer-actions">
            <Show when={props.kind === 'image'}>
              <button onClick={() => setZoomLevel(zoom() - 1)} aria-label="Zoom out">
                <span aria-hidden="true">−</span>
              </button>
              <button onClick={() => setZoomLevel(zoom() + 1)} aria-label="Zoom in">
                <span aria-hidden="true">+</span>
              </button>
            </Show>
            <Show when={canExport() && props.download}>
              <button onClick={download} aria-label={`Download ${props.name}`}>
                <Download size={19} />
              </button>
            </Show>
            <Show when={props.forward && canExport()}>
              <button onClick={props.forward} aria-label="Forward message">
                <Forward size={19} />
              </button>
            </Show>
            <Show when={props.edit}>
              <button onClick={props.edit} aria-label="Edit message">
                <Pencil size={19} />
              </button>
            </Show>
            <Show when={props.delete}>
              <button onClick={props.delete} aria-label="Delete message">
                <Trash2 size={19} />
              </button>
            </Show>
            <Show when={props.goToMessage}>
              <button onClick={props.goToMessage} aria-label="Go to message">
                <ExternalLink size={19} />
              </button>
            </Show>
            <button autofocus onClick={props.close} aria-label="Close media preview">
              <X size={22} />
            </button>
          </div>
        </header>
        <div
          class="media-viewer-content"
          onClick={closeOutsideMedia}
          onWheel={(event) => {
            if (props.kind !== 'image') return;
            event.preventDefault();
            setZoomLevel(zoom() + (event.deltaY < 0 ? 1 : -1));
          }}
        >
          {props.kind === 'image' ? (
            <img
              src={props.url}
              alt={props.name}
              data-zoom={String(zoom())}
              classList={{ 'media-viewer-origin': Boolean(props.origin) }}
              style={{
                ...originStyle(),
                transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})`,
                cursor: zoom() > 1 ? 'grab' : 'zoom-in',
              }}
              onDblClick={(event) => {
                event.stopPropagation();
                setZoomLevel(zoom() > 1 ? 1 : 2);
              }}
              onPointerDown={(event) => {
                if (zoom() <= 1) return;
                event.stopPropagation();
                drag = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  panX: pan().x,
                  panY: pan().y,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!drag || drag.pointerId !== event.pointerId) return;
                setPan({
                  x: drag.panX + event.clientX - drag.startX,
                  y: drag.panY + event.clientY - drag.startY,
                });
              }}
              onPointerUp={() => (drag = undefined)}
              onContextMenu={openContextMenu}
            />
          ) : (
            <video
              src={props.url}
              controls
              playsinline
              preload="metadata"
              aria-label={props.name}
              onContextMenu={openContextMenu}
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
        <Show when={props.caption}>
          <footer class="media-viewer-caption">{props.caption}</footer>
        </Show>
        <Show when={menu()}>
          {(position) => (
            <div
              class="media-viewer-menu"
              role="menu"
              aria-label="Media actions"
              style={{ left: `${position().x}px`, top: `${position().y}px` }}
            >
              <Show when={canExport() && props.download}>
                <button role="menuitem" onClick={download}>
                  <Download size={15} /> Save media as
                </button>
              </Show>
              <Show when={canExport() && props.kind === 'image'}>
                <button role="menuitem" onClick={() => void copyImageUrl(props.url)}>
                  <Copy size={15} /> Copy image
                </button>
              </Show>
              <Show when={canExport() && props.forward}>
                <button role="menuitem" onClick={props.forward}>
                  <Forward size={15} /> Forward
                </button>
              </Show>
              <Show when={props.delete}>
                <button role="menuitem" class="danger" onClick={props.delete}>
                  <Trash2 size={15} /> Delete
                </button>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </Portal>
  );
}
