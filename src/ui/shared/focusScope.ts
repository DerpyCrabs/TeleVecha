interface InertState {
  count: number;
  originallyInert: boolean;
}

interface FocusScopeOptions {
  root: HTMLElement;
  close: () => void;
  inert?: Iterable<HTMLElement | null | undefined>;
  initialFocus?: () => HTMLElement | null | undefined;
  restoreFocus?: () => HTMLElement | null | undefined;
  modal?: boolean;
}

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

const inertStates = new Map<HTMLElement, InertState>();
const scopeStack: symbol[] = [];
let openModalCount = 0;
const listeners = new Set<() => void>();
function changeModalCount(delta: number) {
  openModalCount = Math.max(0, openModalCount + delta);
  for (const listener of listeners) listener();
}
export function subscribeModalVisibility(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const modalVisible = () => openModalCount > 0;

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

/** Owns stacking, inert state, keyboard containment, and focus restoration for one focus scope. */
export function activateFocusScope(options: FocusScopeOptions) {
  const token = Symbol('focus-scope');
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const inerted = [...(options.inert ?? [])].filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  );
  scopeStack.push(token);
  for (const element of inerted) makeInert(element);
  if (options.modal) changeModalCount(1);

  const handleKeyDown = (event: KeyboardEvent) => {
    if (scopeStack.at(-1) !== token) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      options.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(options.root);
    if (focusable.length === 0) {
      event.preventDefault();
      options.root.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !options.root.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !options.root.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener('keydown', handleKeyDown, true);
  const focusFrame = requestAnimationFrame(() => {
    if (scopeStack.at(-1) !== token || !options.root.isConnected) return;
    const preferred =
      options.initialFocus?.() ?? options.root.querySelector<HTMLElement>('[autofocus]');
    (preferred ?? focusableElements(options.root)[0] ?? options.root).focus();
  });

  return () => {
    cancelAnimationFrame(focusFrame);
    document.removeEventListener('keydown', handleKeyDown, true);
    const wasTopmost = scopeStack.at(-1) === token;
    const index = scopeStack.lastIndexOf(token);
    if (index >= 0) scopeStack.splice(index, 1);
    for (const element of inerted) releaseInert(element);
    if (options.modal) changeModalCount(-1);
    if (!wasTopmost) return;
    requestAnimationFrame(() => {
      const target = options.restoreFocus?.() ?? previouslyFocused;
      if (target?.isConnected) target.focus();
    });
  };
}
