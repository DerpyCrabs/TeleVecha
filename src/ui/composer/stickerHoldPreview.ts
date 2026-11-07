import { domBinding } from 'effectweb';

interface HoldPreview {
  show: () => void;
  hide: () => void;
}
function acquire(button: HTMLButtonElement, input: () => HoldPreview) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointer: { id: number; x: number; y: number } | undefined;
  let showing = false;
  let suppressClick = false;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    pointer = undefined;
    if (showing) input().hide();
    showing = false;
  };
  const down = (event: PointerEvent) => {
    clear();
    suppressClick = false;
    if (event.button !== 0 || button.disabled) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      showing = true;
      suppressClick = true;
      input().show();
    }, 350);
  };
  const move = (event: PointerEvent) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (!showing && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8) clear();
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId === pointer?.id) clear();
  };
  const click = (event: MouseEvent) => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const context = (event: MouseEvent) => {
    if (!showing && !suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  button.addEventListener('pointerdown', down);
  button.addEventListener('click', click, true);
  button.addEventListener('contextmenu', context, true);
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
  window.addEventListener('blur', clear);
  return () => {
    clear();
    button.removeEventListener('pointerdown', down);
    button.removeEventListener('click', click, true);
    button.removeEventListener('contextmenu', context, true);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    window.removeEventListener('blur', clear);
  };
}
export const stickerHoldPreview = (value: HoldPreview) => domBinding(value, acquire);
