import { onCleanup, onMount } from 'solid-js';

export function useEscapeDismiss(close: () => void) {
  onMount(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', dismiss);
    onCleanup(() => document.removeEventListener('keydown', dismiss));
  });
}
