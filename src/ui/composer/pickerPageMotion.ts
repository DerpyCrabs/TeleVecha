import { domBinding } from 'effectweb';

function observePage(element: HTMLElement, current: () => string) {
  let previous = current();
  let transition: Animation | undefined;
  return {
    update() {
      const next = current();
      if (previous === next) return;
      previous = next;
      element.scrollTop = 0;
      transition?.cancel();
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      transition = element.animate(
        [
          { opacity: 0.3, translate: '0 var(--picker-page-offset, 4px)' },
          { opacity: 1, translate: '0 0' },
        ],
        { id: 'picker-page', duration: 155, easing: 'ease-out' },
      );
    },
    dispose: () => transition?.cancel(),
  };
}

// Keep the live page and its media elements mounted while the selection changes.
export const pickerPageMotion = (page: string) => domBinding(page, observePage);
