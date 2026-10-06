import { Effect } from 'effect';
import { gunzipSync, strFromU8 } from 'fflate';
import { component, domBinding, view } from 'effectweb';

function acquireAnimation(element: HTMLDivElement, input: () => string) {
  return Effect.scoped(
    Effect.gen(function* () {
      let animation: { destroy(): void; pause(): void; play(): void } | undefined;
      let visible = true;
      const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
      const update = () => {
        if (visible && !motion.matches) animation?.play();
        else animation?.pause();
      };
      const observer =
        'IntersectionObserver' in window
          ? new IntersectionObserver(
              ([entry]) => {
                visible = Boolean(entry?.isIntersecting);
                update();
              },
              { rootMargin: '80px' },
            )
          : undefined;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          observer?.disconnect();
          motion.removeEventListener('change', update);
          animation?.destroy();
          element.replaceChildren();
        }),
      );
      motion.addEventListener('change', update);
      observer?.observe(element);
      delete element.dataset.error;
      const loaded = yield* Effect.tryPromise(async (signal) => {
        const response = await fetch(input(), { signal });
        if (!response.ok) throw new Error(`Animation HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const animationData: unknown = JSON.parse(strFromU8(gunzipSync(new Uint8Array(bytes))));
        const { default: lottie } = await import('lottie-web/build/player/lottie_light');
        return { animationData, lottie };
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            element.dataset.error = 'true';
            return undefined;
          }),
        ),
      );
      if (loaded) {
        animation = loaded.lottie.loadAnimation({
          container: element,
          renderer: 'svg',
          loop: true,
          autoplay: false,
          animationData: loaded.animationData,
        });
        update();
      }
      return yield* Effect.never;
    }),
  );
}

interface TgsPlayerProps {
  source: string;
  label: string;
}

export const TgsPlayer = component<TgsPlayerProps, {}, never>(
  { identity: (props) => props.source, init: () => ({}), update: (model) => ({ model }) },
  view(({ props }) => (
    <div
      use={domBinding(props.source, acquireAnimation)}
      class="tgs-player"
      role="img"
      aria-label={props.label}
    />
  )),
);
