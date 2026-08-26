import Crop from 'lucide-solid/icons/crop';
import RotateCcw from 'lucide-solid/icons/rotate-ccw';
import RotateCw from 'lucide-solid/icons/rotate-cw';
import X from 'lucide-solid/icons/x';
import { Portal } from 'solid-js/web';
import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';

import { transformImageFile, type CropAspect, type ImageRotation } from './imageTransforms';
import type { StagedAttachment } from './outgoingAttachments';
import { useModalDialog } from './useModalDialog';

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

export function ImageAttachmentEditor(props: ImageAttachmentEditorProps) {
  const [rotation, setRotation] = createSignal<ImageRotation>(0);
  const [crop, setCrop] = createSignal<CropAspect>('original');
  const [previewUrl, setPreviewUrl] = createSignal('');
  const [applying, setApplying] = createSignal(false);
  const [error, setError] = createSignal('');
  let overlay: HTMLDivElement | undefined;
  let currentUrl = '';

  useModalDialog(() => overlay, props.close);
  createEffect(() => {
    const file = props.attachment.file;
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(file);
    setPreviewUrl(currentUrl);
  });
  onCleanup(() => {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
  });

  const rotate = (step: number) => {
    const value = (rotation() + step + 360) % 360;
    setRotation(value as ImageRotation);
  };
  const apply = async () => {
    if (applying()) return;
    setApplying(true);
    setError('');
    try {
      props.apply(await transformImageFile(props.attachment.file, rotation(), crop()));
      props.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not edit the image.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <Portal>
      <div
        ref={(element) => (overlay = element)}
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
            data-crop={crop()}
            data-rotation={rotation()}
            style={{
              '--image-rotation': `${rotation()}deg`,
            }}
          >
            <img src={previewUrl()} alt="Image edit preview" />
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
              <For each={crops}>
                {([value, label]) => (
                  <button
                    type="button"
                    aria-pressed={crop() === value}
                    onClick={() => setCrop(value)}
                  >
                    {label}
                  </button>
                )}
              </For>
            </div>
          </div>
          <Show when={error()}>
            <p class="image-editor-error" role="alert">
              {error()}
            </p>
          </Show>
          <footer>
            <button type="button" onClick={props.close}>
              Cancel
            </button>
            <button
              type="button"
              class="primary"
              disabled={applying()}
              onClick={() => void apply()}
            >
              {applying() ? 'Applying…' : 'Apply'}
            </button>
          </footer>
        </section>
      </div>
    </Portal>
  );
}
