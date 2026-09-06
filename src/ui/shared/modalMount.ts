import { domBinding } from 'effectweb';
import { activateFocusScope } from './focusScope';

function acquireModal(modal: HTMLElement, input: () => () => void) {
  const inerted = [...document.body.children].filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element !== modal && !element.contains(modal),
  );
  return activateFocusScope({ root: modal, close: () => input()(), inert: inerted, modal: true });
}
/** Inputs may change without interrupting focus containment or restoring focus prematurely. */
export const modalMount = (close: () => void) => domBinding(close, acquireModal);
