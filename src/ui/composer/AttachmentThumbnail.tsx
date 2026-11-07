import { domBinding, view } from 'effectweb';
import FileText from '@effectweb/lucide/icons/file-text';
import { fileImageMount } from '../shared/fileImageMount';
function acquireVideoThumbnail(element: HTMLVideoElement, input: () => File) {
  let file = input();
  let url = URL.createObjectURL(file);
  element.src = url;
  return {
    update() {
      const next = input();
      if (next === file) return;
      const previous = url;
      url = URL.createObjectURL(next);
      file = next;
      element.src = url;
      URL.revokeObjectURL(previous);
    },
    dispose() {
      element.removeAttribute('src');
      element.load();
      URL.revokeObjectURL(url);
    },
  };
}

export const AttachmentThumbnail = view<{ file: File }, never>((props, _send) =>
  props.file.type.startsWith('image/') ? (
    <img draggable={false} use={fileImageMount(props.file)} alt="" />
  ) : props.file.type.startsWith('video/') ? (
    <video
      use={domBinding(props.file, acquireVideoThumbnail)}
      preload="auto"
      controls
      playsInline
      aria-label={`Video preview: ${props.file.name}`}
    />
  ) : (
    <FileText size={22} aria-hidden="true" />
  ),
);
