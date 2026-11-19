import { domBinding } from 'effectweb';
import { activateFocusScope } from './focusScope';

const releaseScopes = new WeakMap<HTMLElement, () => void>();

// Release interaction as soon as dismissal starts. Only the paint lingers.
export function dismissPanel(from: HTMLElement, close: () => void) {
  const overlay = from.closest<HTMLElement>('.panel-overlay');
  if (
    !overlay?.hasAttribute('data-animate-dismiss') ||
    matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    close();
    return;
  }
  if (overlay.dataset.closing) return;
  overlay.dataset.closing = 'true';
  releaseScopes.get(overlay)?.();
  overlay.inert = true;
  const fade = overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 120,
    easing: 'ease-in',
    fill: 'forwards',
  });
  // A subsequent action may reopen the same dialog before its exit finishes.
  const finish = () => {
    document.removeEventListener('pointerdown', finish, true);
    document.removeEventListener('keydown', finish, true);
    if (overlay.isConnected) close();
    delete overlay.dataset.closing;
    fade.cancel();
  };
  fade.onfinish = finish;
  document.addEventListener('pointerdown', finish, true);
  document.addEventListener('keydown', finish, true);
}

function acquireModal(modal: HTMLElement, input: () => () => void) {
  const inerted = [...document.body.children].filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element !== modal && !element.contains(modal),
  );
  const deactivate = activateFocusScope({
    root: modal,
    close: () => dismissPanel(modal, input()),
    inert: inerted,
    modal: true,
  });
  const release = () => {
    if (!releaseScopes.delete(modal)) return;
    deactivate();
  };
  releaseScopes.set(modal, release);
  return release;
}
/** Inputs may change without interrupting focus containment or restoring focus prematurely. */
export const modalMount = (close: () => void) => domBinding(close, acquireModal);
