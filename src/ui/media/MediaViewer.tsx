import ChevronLeft from '@effectweb/lucide/icons/chevron-left';
import ChevronRight from '@effectweb/lucide/icons/chevron-right';
import Download from '@effectweb/lucide/icons/download';
import ExternalLink from '@effectweb/lucide/icons/external-link';
import Forward from '@effectweb/lucide/icons/forward';
import Pencil from '@effectweb/lucide/icons/pencil';
import Trash2 from '@effectweb/lucide/icons/trash-2';
import X from '@effectweb/lucide/icons/x';
import { Portal, component, domBinding, view } from 'effectweb';
import { modalMount } from '../shared/modalMount';
import { saveMediaUrl } from './mediaActions';
function mediaDimensions(element: HTMLImageElement | HTMLVideoElement) {
  return element instanceof HTMLImageElement
    ? { width: element.naturalWidth, height: element.naturalHeight }
    : { width: element.videoWidth, height: element.videoHeight };
}
function acquireOrigin(element: HTMLImageElement, input: () => DOMRect | undefined) {
  let origin = input();
  const clear = () => {
    element.style.removeProperty('--media-origin-x');
    element.style.removeProperty('--media-origin-y');
    element.style.removeProperty('--media-origin-scale');
  };
  const apply = () => {
    const width = document.documentElement.clientWidth,
      height = document.documentElement.clientHeight;
    const properties = origin
      ? {
          '--media-origin-x': `${origin.left + origin.width / 2 - width / 2}px`,
          '--media-origin-y': `${origin.top + origin.height / 2 - height / 2}px`,
          '--media-origin-scale': String(
            Math.max(0.05, Math.min(1, origin.width / width, origin.height / height)),
          ),
        }
      : undefined;
    if (properties)
      for (const [key, value] of Object.entries(properties)) element.style.setProperty(key, value);
  };
  apply();
  return {
    update() {
      const next = input();
      if (next === origin) return;
      clear();
      origin = next;
      apply();
    },
    dispose: clear,
  };
}
const originMount = (origin: DOMRect | undefined) => domBinding(origin, acquireOrigin);
function acquirePlayback(video: HTMLVideoElement, input: () => string) {
  let source = input();
  const start = () => {
    video.play().catch(() => undefined);
  };
  start();
  return {
    update() {
      const next = input();
      if (next === source) return;
      source = next;
      start();
    },
    dispose() {
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
  };
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
type MediaViewerState = {
  zoom: number;
  pan: { x: number; y: number };
  menu: { x: number; y: number } | undefined;
  dragging:
    | { pointerId: number; startX: number; startY: number; panX: number; panY: number }
    | undefined;
};
type MediaViewerMessage =
  | { type: 'Zoom'; value: number }
  | { type: 'Pan'; value: { x: number; y: number } }
  | { type: 'Menu'; value: { x: number; y: number } | undefined }
  | {
      type: 'Dragging';
      value:
        | { pointerId: number; startX: number; startY: number; panX: number; panY: number }
        | undefined;
    };
export const MediaViewer = component<MediaViewerProps, MediaViewerState, MediaViewerMessage>(
  {
    init: () => ({ zoom: 1, pan: { x: 0, y: 0 }, menu: undefined, dragging: undefined }),
    update: (model, message) => {
      switch (message.type) {
        case 'Zoom':
          return { model: { ...model, zoom: message.value } };
        case 'Pan':
          return { model: { ...model, pan: message.value } };
        case 'Menu':
          return { model: { ...model, menu: message.value } };
        case 'Dragging':
          return { model: { ...model, dragging: message.value } };
      }
    },
  },
  view((model, send) => {
    const props = model.props;
    const resetView = () => {
      send({ type: 'Zoom', value: 1 });
      send({ type: 'Pan', value: { x: 0, y: 0 } });
    };
    const setZoomLevel = (value: number) => {
      const next = Math.max(1, Math.min(4, value));
      send({ type: 'Zoom', value: next });
      if (next === 1) send({ type: 'Pan', value: { x: 0, y: 0 } });
    };
    const closeOutsideMedia = (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
      if (model.zoom > 1) return;
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
      send({ type: 'Menu', value: { x: event.clientX, y: event.clientY } });
    };
    const download = () =>
      props.download ? props.download() : saveMediaUrl(props.url, props.name);
    const canExport = () => !props.protected;
    return (
      <Portal>
        <div
          use={modalMount(props.close)}
          class="media-viewer"
          role="dialog"
          aria-modal="true"
          aria-label={`Media preview: ${props.name}`}
          tabIndex={-1}
          onKeyDown={navigateWithKeyboard}
          onPointerDown={() => send({ type: 'Menu', value: undefined })}
        >
          <header>
            <div class="media-viewer-title">
              <strong>{props.author || props.name}</strong>
              {props.author && props.time ? <small>{props.time}</small> : null}
              {(props.count ?? 0) > 1 ? (
                <small aria-label={`Attachment ${props.position} of ${props.count}`}>
                  {props.position} / {props.count}
                </small>
              ) : null}
            </div>
            <div class="media-viewer-actions">
              {props.kind === 'image' ? (
                <>
                  <button onClick={() => setZoomLevel(model.zoom - 1)} aria-label="Zoom out">
                    <span aria-hidden="true">−</span>
                  </button>
                  <button onClick={() => setZoomLevel(model.zoom + 1)} aria-label="Zoom in">
                    <span aria-hidden="true">+</span>
                  </button>
                </>
              ) : null}
              {canExport() && props.download ? (
                <button onClick={download} aria-label={`Download ${props.name}`}>
                  <Download size={19} />
                </button>
              ) : null}
              {props.forward && canExport() ? (
                <button onClick={props.forward} aria-label="Forward message">
                  <Forward size={19} />
                </button>
              ) : null}
              {props.edit ? (
                <button onClick={props.edit} aria-label="Edit message">
                  <Pencil size={19} />
                </button>
              ) : null}
              {props.delete ? (
                <button onClick={props.delete} aria-label="Delete message">
                  <Trash2 size={19} />
                </button>
              ) : null}
              {props.goToMessage ? (
                <button onClick={props.goToMessage} aria-label="Go to message">
                  <ExternalLink size={19} />
                </button>
              ) : null}
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
              setZoomLevel(model.zoom + (event.deltaY < 0 ? 1 : -1));
            }}
          >
            {props.kind === 'image' ? (
              <img
                use={originMount(props.origin)}
                src={props.url}
                alt={props.name}
                data-zoom={String(model.zoom)}
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
                classList={{ 'media-viewer-origin': Boolean(props.origin) }}
                style={{
                  transform: `translate(${model.pan.x}px, ${model.pan.y}px) scale(${model.zoom})`,
                  cursor: model.dragging ? 'grabbing' : model.zoom > 1 ? 'grab' : 'zoom-in',
                  transition: model.dragging ? 'none' : undefined,
                }}
                onDblClick={(event) => {
                  event.stopPropagation();
                  setZoomLevel(model.zoom > 1 ? 1 : 2);
                }}
                onPointerDown={(event) => {
                  if (model.zoom <= 1 || event.button !== 0 || model.dragging) return;
                  event.preventDefault();
                  event.stopPropagation();
                  send({
                    type: 'Dragging',
                    value: {
                      pointerId: event.pointerId,
                      startX: event.clientX,
                      startY: event.clientY,
                      panX: model.pan.x,
                      panY: model.pan.y,
                    },
                  });
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const drag = model.dragging;
                  if (!drag || drag.pointerId !== event.pointerId) return;
                  send({
                    type: 'Pan',
                    value: {
                      x: drag.panX + event.clientX - drag.startX,
                      y: drag.panY + event.clientY - drag.startY,
                    },
                  });
                }}
                onPointerUp={(event) => {
                  if (model.dragging?.pointerId !== event.pointerId) return;
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  send({ type: 'Dragging', value: undefined });
                }}
                onLostPointerCapture={(event) => {
                  if (model.dragging?.pointerId === event.pointerId)
                    send({ type: 'Dragging', value: undefined });
                }}
                onPointerCancel={(event) => {
                  if (model.dragging?.pointerId === event.pointerId)
                    send({ type: 'Dragging', value: undefined });
                }}
              />
            ) : (
              <video
                use={domBinding(props.url, acquirePlayback)}
                src={props.url}
                autoplay
                controls
                playsinline
                preload="auto"
                aria-label={props.name}
                onContextMenu={openContextMenu}
              />
            )}
            {(props.count ?? 0) > 1 ? (
              <>
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
              </>
            ) : null}
          </div>
          {props.caption ? <footer class="media-viewer-caption">{props.caption}</footer> : null}
          {model.menu
            ? ((position) => (
                <div
                  class="media-viewer-menu"
                  role="menu"
                  aria-label="Media actions"
                  style={{ left: `${position.x}px`, top: `${position.y}px` }}
                >
                  {canExport() && props.download ? (
                    <button role="menuitem" onClick={download}>
                      <Download size={15} /> Save media as
                    </button>
                  ) : null}
                  {canExport() && props.forward ? (
                    <button role="menuitem" onClick={props.forward}>
                      <Forward size={15} /> Forward
                    </button>
                  ) : null}
                  {props.delete ? (
                    <button role="menuitem" class="danger" onClick={props.delete}>
                      <Trash2 size={15} /> Delete
                    </button>
                  ) : null}
                </div>
              ))(model.menu!)
            : null}
        </div>
      </Portal>
    );
  }),
);
