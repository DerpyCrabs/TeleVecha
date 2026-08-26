import { onCleanup, onMount } from 'solid-js';

interface InertState {
  count: number;
  originallyInert: boolean;
}

const inertStates = new Map<HTMLElement, InertState>();
const modalStack: symbol[] = [];
const focusableSelector = [
  'a[href]',
  'audio[controls]',
  'button:not([disabled])',
  'details > summary:first-of-type',
  'iframe',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (element) => !element.hidden && element.getClientRects().length > 0,
  );
}

function makeInert(element: HTMLElement) {
  const current = inertStates.get(element);
  if (current) {
    current.count += 1;
    return;
  }
  inertStates.set(element, { count: 1, originallyInert: element.inert });
  element.inert = true;
}

function releaseInert(element: HTMLElement) {
  const current = inertStates.get(element);
  if (!current) return;
  current.count -= 1;
  if (current.count > 0) return;
  element.inert = current.originallyInert;
  inertStates.delete(element);
}

/** Keeps a portalled modal isolated, keyboard-contained, and focus-safe. */
export function useModalDialog(root: () => HTMLElement | undefined, close: () => void) {
  onMount(() => {
    const modal = root();
    if (!modal) return;
    const token = Symbol('modal');
    modalStack.push(token);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const inerted = [...document.body.children]
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element !== modal && !element.contains(modal),
      )
      .map((element) => {
        makeInert(element);
        return element;
      });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== token) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements(modal);
      if (focusable.length === 0) {
        event.preventDefault();
        modal.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !modal.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !modal.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.dispatchEvent(new Event('televecha:modal-visibility-change'));
    queueMicrotask(() => {
      if (modalStack.at(-1) !== token || !modal.isConnected) return;
      const preferred = modal.querySelector<HTMLElement>('[autofocus]');
      (preferred ?? focusableElements(modal)[0] ?? modal).focus();
    });

    onCleanup(() => {
      document.removeEventListener('keydown', handleKeyDown, true);
      const wasTopmost = modalStack.at(-1) === token;
      const index = modalStack.lastIndexOf(token);
      if (index >= 0) modalStack.splice(index, 1);
      for (const element of inerted) releaseInert(element);
      if (wasTopmost && previouslyFocused?.isConnected) {
        queueMicrotask(() => previouslyFocused.isConnected && previouslyFocused.focus());
      }
      queueMicrotask(() => document.dispatchEvent(new Event('televecha:modal-visibility-change')));
    });
  });
}
