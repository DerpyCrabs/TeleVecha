import X from '@effectweb/lucide/icons/x';
import { Portal, view, type JSX } from 'effectweb';
import { dismissPanel, modalMount } from './modalMount';
import { panelClass, panelCloseButtonClass, panelHeaderClass } from './panelStyles';

/** One modal lifetime owns focus containment, dismissal and accessible labeling. */
export const Dialog = view<
  {
    title: string;
    label?: string;
    onClose: () => void;
    closeLabel?: string;
    animateDismiss?: boolean;
    class?: string;
    children?: JSX.Element;
    footer?: JSX.Element;
    headerLeading?: JSX.Element;
  },
  never
>((props, _send) => (
  <Portal>
    <div
      use={modalMount(props.onClose)}
      class="panel-overlay"
      data-animate-dismiss={props.animateDismiss !== false ? '' : undefined}
      role="presentation"
      tabIndex={-1}
      onPointerDown={(event) =>
        event.target === event.currentTarget && dismissPanel(event.currentTarget, props.onClose)
      }
    >
      <section
        class={props.class ?? panelClass}
        role="dialog"
        aria-modal="true"
        aria-label={props.label ?? props.title}
      >
        <header class={panelHeaderClass}>
          {props.headerLeading ? (
            <span class="flex min-w-0 items-center gap-2">
              {props.headerLeading}
              <strong class="truncate">{props.title}</strong>
            </span>
          ) : (
            <strong>{props.title}</strong>
          )}
          <button
            class={panelCloseButtonClass}
            onClick={(event) => dismissPanel(event.currentTarget, props.onClose)}
            aria-label={props.closeLabel ?? 'Close dialog'}
          >
            <X size={18} />
          </button>
        </header>
        {props.children}
        {props.footer}
      </section>
    </div>
  </Portal>
));
