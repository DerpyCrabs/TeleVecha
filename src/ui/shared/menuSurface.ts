import { Effect } from 'effect';
import { component, domBinding, view, type JSX } from 'effectweb';

type Point = { x: number; y: number };

// Retain the last target while its menu fades. A new target cancels disposal.
export function createMenuPresence<T>() {
  return component<
    { value: T | undefined; render: (value: T, closing: boolean) => JSX.Element },
    { leaving: { value: T } | undefined },
    { type: 'Exited' }
  >(
    {
      init: () => ({ leaving: undefined }),
      receive(model, previous) {
        if (model.props.value !== undefined && !model.leaving) return { model };
        if (model.props.value !== undefined)
          return { model: { ...model, leaving: undefined }, cancel: ['exit'] };
        if (previous.value === undefined) return { model };
        return {
          model: { ...model, leaving: { value: previous.value } },
          commands: [
            {
              key: 'exit',
              policy: 'replace',
              effect: Effect.as(Effect.sleep(140), { type: 'Exited' } as const),
            },
          ],
        };
      },
      update: (model) => ({ model: { ...model, leaving: undefined } }),
    },
    view((model) => {
      const value = model.props.value ?? model.leaving?.value;
      return value === undefined
        ? null
        : model.props.render(value, model.props.value === undefined);
    }),
  );
}

export const ToggleMenu = createMenuPresence<true>();
export const PointMenu = createMenuPresence<Point>();

function positionMenu(element: HTMLElement, read: () => Point) {
  const place = () => {
    const { x, y } = read();
    const edge = 8;
    const left = x + element.offsetWidth + edge <= innerWidth ? x : x - element.offsetWidth;
    const fitsBelow = y + element.offsetHeight + edge <= innerHeight;
    const top = fitsBelow ? y : y - element.offsetHeight;

    element.style.left =
      Math.max(edge, Math.min(innerWidth - edge - element.offsetWidth, left)) + 'px';
    element.style.top =
      Math.max(edge, Math.min(innerHeight - edge - element.offsetHeight, top)) + 'px';
  };
  // The pointer target stays stationary while the surface fades in.
  element.style.setProperty('--menu-offset', '0px');
  place();
  const observer = new ResizeObserver(place);
  observer.observe(element);
  window.addEventListener('resize', place);
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', place);
  };
}

export const menuAtPoint = (point: Point) =>
  domBinding(point, positionMenu, { identity: [point.x, point.y] });
