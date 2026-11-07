import { list, Portal, resourceError, sequence, view, component } from 'effectweb';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { Effect } from 'effect';
import Crop from '@effectweb/lucide/icons/crop';
import Pencil from '@effectweb/lucide/icons/pencil';
import Sliders from '@effectweb/lucide/icons/sliders-horizontal';
import RotateCw from '@effectweb/lucide/icons/rotate-cw';
import Undo from '@effectweb/lucide/icons/undo-2';
import Redo from '@effectweb/lucide/icons/redo-2';
import {
  imageEditHistory,
  initialImageEdit,
  changeImageEdit,
  beginImageEdit,
  endImageEdit,
  undoImageEdit,
  redoImageEdit,
  type ImageEdit,
} from './imageEditHistory';
import X from '@effectweb/lucide/icons/x';
import { modalMount } from '../shared/modalMount';
import { imageEditorPreview } from './imageEditorPreview';
import FlipHorizontal from '@effectweb/lucide/icons/flip-horizontal-2';
import { transformImageFile, type ImageAdjustments, type ImageRotation } from './imageTransforms';
import type { StagedAttachment } from './outgoingAttachments';
interface ImageAttachmentEditorProps {
  attachment: StagedAttachment;
  close: () => void;
  apply: (file: File) => void;
}
const crops = [
  ['original', 'Original'],
  ['square', 'Square'],
  ['4:3', '4:3'],
  ['16:9', '16:9'],
  ['3:4', '3:4'],
  ['9:16', '9:16'],
] as const;

const adjustments = [
  ['brightness', 'Brightness'],
  ['contrast', 'Contrast'],
  ['saturation', 'Saturation'],
] as const;

export const ImageAttachmentEditor = component(
  {
    init: (_props: ImageAttachmentEditorProps) => ({
      history: imageEditHistory(),
      tool: 'crop' as 'crop' | 'draw' | 'adjust',
      adjustment: 'brightness' as 'brightness' | 'contrast' | 'saturation',
      penColor: '#ff5252',
      penWidth: 0.012,
      previewError: '',
      applied: AsyncResult.initial() as AsyncResult.AsyncResult<File, unknown>,
    }),
    identity: (props) => props.attachment.id,
  },
  (owner) =>
    view((model) => {
      const props = model.props;
      const error =
        model.previewError || (model.applied.waiting ? '' : resourceError(model.applied));
      const change = (values: Partial<ImageEdit>) => {
        const { history, applied } = owner.read();
        if (!applied.waiting)
          owner.patch({ history: changeImageEdit(history, { ...history.present, ...values }) });
      };
      const gesture = (begin: boolean) =>
        owner.patch({ history: (begin ? beginImageEdit : endImageEdit)(owner.read().history) });
      const undo = () => {
        if (!owner.read().applied.waiting)
          owner.patch({ history: undoImageEdit(owner.read().history) });
      };
      const redo = () => {
        if (!owner.read().applied.waiting)
          owner.patch({ history: redoImageEdit(owner.read().history) });
      };
      const adjust = (values: Partial<ImageAdjustments>) =>
        change({ adjustments: { ...owner.read().history.present.adjustments, ...values } });
      const rotate = (step: number) =>
        change({
          rotation: ((owner.read().history.present.rotation + step + 360) % 360) as ImageRotation,
        });
      const apply = () =>
        owner.task(
          'applied',
          transformImageFile(
            props.attachment.file,
            model.history.present.rotation,
            model.history.present.crop,
            model.history.present.adjustments,
            model.history.present.strokes,
          ).pipe(
            Effect.tap((file) =>
              Effect.sync(() => {
                props.apply(file);
                props.close();
              }),
            ),
          ),
          'drop',
        );
      return (
        <Portal>
          <div use={modalMount(props.close)} class="image-editor-overlay" tabIndex={-1}>
            <section
              class="image-editor"
              role="dialog"
              aria-modal="true"
              aria-label="Edit image"
              onKeyDown={(event) => {
                if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
                const key = event.key.toLowerCase();
                if (key !== 'z' && key !== 'y') return;
                event.preventDefault();
                event.stopPropagation();
                if (key === 'y' || event.shiftKey) redo();
                else undo();
              }}
            >
              <header>
                <button
                  type="button"
                  class="image-editor-reset"
                  onClick={() => change(initialImageEdit())}
                  disabled={model.applied.waiting}
                  title="Reset all edits"
                >
                  Reset
                </button>
                <div class="image-editor-history">
                  <button
                    type="button"
                    aria-label="Undo image edit"
                    title="Undo (Ctrl/⌘ Z)"
                    disabled={!model.history.past.length || model.applied.waiting}
                    onClick={undo}
                  >
                    <Undo size={20} />
                  </button>
                  <button
                    type="button"
                    aria-label="Redo image edit"
                    title="Redo (Ctrl/⌘ Shift Z)"
                    disabled={!model.history.future.length || model.applied.waiting}
                    onClick={redo}
                  >
                    <Redo size={20} />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={props.close}
                  aria-label="Close image editor"
                  title="Close"
                >
                  <X size={20} />
                </button>
              </header>
              <div class="image-editor-preview">
                <canvas
                  tabIndex={0}
                  data-drawing={model.tool === 'draw' || undefined}
                  aria-label={
                    model.tool === 'draw'
                      ? 'Image edit preview. Draw on the image.'
                      : 'Image edit preview. Drag to reposition the crop or use arrow keys.'
                  }
                  use={imageEditorPreview({
                    file: props.attachment.file,
                    rotation: model.history.present.rotation,
                    crop: model.history.present.crop,
                    adjustments: model.history.present.adjustments,
                    gesture,
                    strokes: model.history.present.strokes,
                    drawing:
                      model.tool === 'draw'
                        ? { color: model.penColor, width: model.penWidth }
                        : undefined,
                    stroke: (stroke) =>
                      change({ strokes: [...owner.read().history.present.strokes, stroke] }),
                    move: (positionX, positionY) => adjust({ positionX, positionY }),
                    error: (previewError) => owner.patch({ previewError }),
                  })}
                />
              </div>
              {error ? (
                <p class="image-editor-error" role="alert">
                  {error}
                </p>
              ) : null}
              <div class="image-editor-tool-options">
                {model.tool === 'crop' ? (
                  <>
                    <select
                      aria-label="Crop aspect ratio"
                      value={model.history.present.crop}
                      onChange={(event) =>
                        change({ crop: event.currentTarget.value as ImageEdit['crop'] })
                      }
                    >
                      {list(sequence(crops), ([value, label]) => (
                        <option value={value}>{label}</option>
                      ))}
                    </select>
                    <input
                      type="range"
                      aria-label="Zoom"
                      min="1"
                      max="4"
                      step="0.05"
                      value={model.history.present.adjustments.zoom}
                      onPointerDown={() => gesture(true)}
                      onPointerUp={() => gesture(false)}
                      onPointerCancel={() => gesture(false)}
                      onChange={() => gesture(false)}
                      onInput={(event) => adjust({ zoom: Number(event.currentTarget.value) })}
                    />
                    <output>{model.history.present.adjustments.zoom.toFixed(1)}×</output>
                  </>
                ) : model.tool === 'draw' ? (
                  <>
                    <input
                      type="color"
                      aria-label="Brush color"
                      title="Brush color"
                      value={model.penColor}
                      onInput={(event) => owner.patch({ penColor: event.currentTarget.value })}
                    />
                    <input
                      type="range"
                      aria-label="Brush size"
                      min="0.003"
                      max="0.06"
                      step="0.001"
                      value={model.penWidth}
                      onInput={(event) =>
                        owner.patch({ penWidth: Number(event.currentTarget.value) })
                      }
                    />
                    <span
                      class="image-editor-brush-sample"
                      style={{
                        background: model.penColor,
                        width: `${Math.max(4, model.penWidth * 400)}px`,
                        height: `${Math.max(4, model.penWidth * 400)}px`,
                      }}
                    />
                  </>
                ) : (
                  <>
                    <select
                      aria-label="Image adjustment"
                      value={model.adjustment}
                      onChange={(event) =>
                        owner.patch({
                          adjustment: event.currentTarget.value as
                            | 'brightness'
                            | 'contrast'
                            | 'saturation',
                        })
                      }
                    >
                      {list(
                        adjustments,
                        ([key]) => key,
                        ([key, label]) => (
                          <option value={key}>{label}</option>
                        ),
                      )}
                    </select>
                    <input
                      type="range"
                      aria-label={model.adjustment}
                      min="0"
                      max="200"
                      step="1"
                      value={model.history.present.adjustments[model.adjustment]}
                      onPointerDown={() => gesture(true)}
                      onPointerUp={() => gesture(false)}
                      onPointerCancel={() => gesture(false)}
                      onChange={() => gesture(false)}
                      onInput={(event) =>
                        adjust({ [model.adjustment]: Number(event.currentTarget.value) })
                      }
                    />
                    <output>{model.history.present.adjustments[model.adjustment]}%</output>
                  </>
                )}
              </div>
              <footer>
                <button type="button" class="image-editor-edge" onClick={props.close}>
                  Cancel
                </button>
                <div class="image-editor-tools" role="group" aria-label="Image tools">
                  <button
                    type="button"
                    aria-label="Crop"
                    title="Crop"
                    aria-pressed={model.tool === 'crop'}
                    onClick={() => owner.patch({ tool: 'crop' })}
                  >
                    <Crop size={21} />
                  </button>
                  {model.tool === 'crop' ? (
                    <>
                      <button
                        type="button"
                        aria-label="Rotate right"
                        title="Rotate right"
                        onClick={() => rotate(90)}
                      >
                        <RotateCw size={21} />
                      </button>
                      <button
                        type="button"
                        aria-label="Flip horizontally"
                        title="Flip horizontally"
                        aria-pressed={model.history.present.adjustments.flip}
                        onClick={() => adjust({ flip: !model.history.present.adjustments.flip })}
                      >
                        <FlipHorizontal size={21} />
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Draw"
                    title="Draw"
                    aria-pressed={model.tool === 'draw'}
                    onClick={() => owner.patch({ tool: 'draw' })}
                  >
                    <Pencil size={21} />
                  </button>
                  <button
                    type="button"
                    aria-label="Adjust image"
                    title="Adjust image"
                    aria-pressed={model.tool === 'adjust'}
                    onClick={() => owner.patch({ tool: 'adjust' })}
                  >
                    <Sliders size={21} />
                  </button>
                </div>
                <button
                  type="button"
                  class="image-editor-edge primary"
                  disabled={model.applied.waiting || !!model.previewError}
                  onClick={apply}
                >
                  {model.applied.waiting ? 'Saving…' : 'Done'}
                </button>
              </footer>
            </section>
          </div>
        </Portal>
      );
    }),
);
