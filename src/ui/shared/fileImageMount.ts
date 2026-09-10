import { domBinding } from 'effectweb';

function acquireFileImage(element: HTMLImageElement, input: () => File) {
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
    dispose: () => URL.revokeObjectURL(url),
  };
}

export const fileImageMount = (file: File) => domBinding(file, acquireFileImage);
