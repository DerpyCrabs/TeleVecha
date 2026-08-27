import { onCleanup, onMount } from 'solid-js';
import { activateFocusScope } from './focusScope';

/** Keeps a portalled modal isolated, keyboard-contained, and focus-safe. */
export function useModalDialog(root: () => HTMLElement | undefined, close: () => void) {
  onMount(() => {
    const modal = root();
    if (!modal) return;
    const inerted = [...document.body.children].filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== modal && !element.contains(modal),
    );
    const deactivate = activateFocusScope({ root: modal, close, inert: inerted, modal: true });
    onCleanup(deactivate);
  });
}
