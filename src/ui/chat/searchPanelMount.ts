import { domBinding } from 'effectweb';
import { activateFocusScope } from '../shared/focusScope';
interface SearchPanelMount {
  compact: boolean;
  close: () => void;
}
function acquire(root: HTMLElement, input: () => SearchPanelMount) {
  let compact: boolean | undefined;
  let release: (() => void) | undefined;
  const update = () => {
    const next = input().compact;
    if (compact === next) return;
    release?.();
    compact = next;
    release = next
      ? activateFocusScope({
          root,
          close: () => input().close(),
          modal: true,
          inert: [...(root.parentElement?.children ?? [])].filter(
            (element): element is HTMLElement => element instanceof HTMLElement && element !== root,
          ),
          initialFocus: () => root.querySelector('input[type=search]'),
        })
      : undefined;
  };
  update();
  const frame = requestAnimationFrame(() =>
    root.querySelector<HTMLInputElement>('input[type=search]')?.focus(),
  );
  const key = (event: KeyboardEvent) => {
    if (!input().compact && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      input().close();
    }
  };
  root.addEventListener('keydown', key);
  return {
    update,
    dispose() {
      cancelAnimationFrame(frame);
      release?.();
      root.removeEventListener('keydown', key);
    },
  };
}
export const searchPanelMount = (value: SearchPanelMount) => domBinding(value, acquire);
