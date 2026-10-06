import { list, Portal, resourceError, sequence, view, component, ownerOf } from 'effectweb';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { Effect } from 'effect';
import Crop from '@effectweb/lucide/icons/crop';
import RotateCcw from '@effectweb/lucide/icons/rotate-ccw';
import RotateCw from '@effectweb/lucide/icons/rotate-cw';
import X from '@effectweb/lucide/icons/x';
import { modalMount } from '../shared/modalMount';
import { fileImageMount } from '../shared/fileImageMount';
import type { CropAspect } from './imageTransforms';
import { transformImageFile, type ImageRotation } from './imageTransforms';
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
] as const;

export const ImageAttachmentEditor = component(
  {
    init: (_props: ImageAttachmentEditorProps) => ({
      rotation: 0 as ImageRotation,
      crop: 'original' as CropAspect,
      applied: AsyncResult.initial() as AsyncResult.AsyncResult<File, unknown>,
    }),
    identity: (props) => props.attachment.id,
  },
  view((model, patch) => {
    const props = model.props;
    const error = model.applied.waiting ? '' : resourceError(model.applied);
    const rotate = (step: number) => {
      const value = (model.rotation + step + 360) % 360;
      patch({ rotation: value as ImageRotation });
    };
    const apply = () =>
      ownerOf(patch).task(
        'applied',
        transformImageFile(props.attachment.file, model.rotation, model.crop).pipe(
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
        <div
          use={modalMount(props.close)}
          class="image-editor-overlay"
          tabIndex={-1}
          onPointerDown={(event) => event.target === event.currentTarget && props.close()}
        >
          <section
            class="image-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="image-editor-title"
          >
            <header>
              <h2 id="image-editor-title">Edit image</h2>
              <button type="button" onClick={props.close} aria-label="Close image editor">
                <X size={18} />
              </button>
            </header>
            <div
              class="image-editor-preview"
              data-crop={model.crop}
              data-rotation={model.rotation}
              style={{ '--image-rotation': `${model.rotation}deg` }}
            >
              <img
                draggable={false}
                use={fileImageMount(props.attachment.file)}
                alt="Image edit preview"
              />
            </div>
            <div class="image-editor-controls">
              <div class="image-editor-rotate" aria-label="Rotate image">
                <button type="button" onClick={() => rotate(-90)} aria-label="Rotate left">
                  <RotateCcw size={17} /> Rotate left
                </button>
                <button type="button" onClick={() => rotate(90)} aria-label="Rotate right">
                  <RotateCw size={17} /> Rotate right
                </button>
              </div>
              <div class="image-editor-crops" aria-label="Crop aspect ratio">
                <span>
                  <Crop size={16} /> Crop
                </span>
                {list(sequence(crops), (_item) => {
                  const [value, label] = _item;
                  return (
                    <button
                      type="button"
                      aria-pressed={model.crop === value}
                      onClick={() => patch({ crop: value })}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            {error ? (
              <p class="image-editor-error" role="alert">
                {error}
              </p>
            ) : null}
            <footer>
              <button type="button" onClick={props.close}>
                Cancel
              </button>
              <button
                type="button"
                class="primary"
                disabled={model.applied.waiting}
                onClick={apply}
              >
                {model.applied.waiting ? 'Applying…' : 'Apply'}
              </button>
            </footer>
          </section>
        </div>
      </Portal>
    );
  }),
);
