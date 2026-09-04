import Clock3 from 'lucide-solid/icons/clock-3';
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';

import type { TelegramSticker, TelegramStickerPack } from '../../telegram/types';
import { TgsPlayer } from '../media/TgsPlayer';
import { VisibilityVideo } from '../media/VisibilityVideo';

interface StickerImageProps {
  sticker: TelegramSticker;
  load: () => Promise<string>;
  cachedUrl: () => string | undefined;
  eager?: boolean;
  label?: string | undefined;
}

function StickerImage(props: StickerImageProps) {
  const [source, setSource] = createSignal(props.cachedUrl() ?? '');
  let root: HTMLSpanElement | undefined;
  const load = () => {
    if (!source()) void props.load().then(setSource, () => undefined);
  };
  onMount(() => {
    if (props.eager || !('IntersectionObserver' in window)) return load();
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        load();
      },
      { root: root?.closest('.sticker-pack-grid') ?? null, rootMargin: '120px' },
    );
    if (root) observer.observe(root);
    onCleanup(() => observer.disconnect());
  });
  return (
    <span ref={(element) => (root = element)} class="sticker-image">
      <Show
        when={source()}
        fallback={<span class="sticker-placeholder">{props.sticker.emoji}</span>}
      >
        {(url) => (
          <Show
            when={props.sticker.mimeType === 'application/x-tgsticker'}
            fallback={
              <Show
                when={props.sticker.mimeType.startsWith('video/')}
                fallback={<img src={url()} alt="" />}
              >
                <VisibilityVideo source={url()} label={props.label} />
              </Show>
            }
          >
            <TgsPlayer
              source={url()}
              label={props.label ?? `${props.sticker.emoji} animated sticker`}
            />
          </Show>
        )}
      </Show>
    </span>
  );
}

export function StickerPicker(props: {
  packs: TelegramStickerPack[];
  loading: boolean;
  query: string;
  load: (sticker: TelegramSticker) => Promise<string>;
  cachedUrl: (sticker: TelegramSticker) => string | undefined;
  send: (sticker: TelegramSticker) => void;
  enabled: boolean;
}) {
  const [activePackId, setActivePackId] = createSignal('recent');
  const activePack = () => props.packs.find(({ id }) => id === activePackId()) ?? props.packs[0];
  const results = createMemo(() => {
    const term = props.query.trim().toLocaleLowerCase();
    if (!term) return activePack()?.stickers ?? [];
    return props.packs.flatMap((pack) =>
      pack.stickers.filter((sticker) =>
        `${pack.title} ${sticker.emoji}`.toLocaleLowerCase().includes(term),
      ),
    );
  });
  return (
    <div class="sticker-picker" aria-label="Stickers">
      <Show when={!props.loading} fallback={<p>Loading sticker index…</p>}>
        <nav
          class="sticker-pack-tabs"
          aria-label="Sticker packs"
          onWheel={(event) => {
            if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
            const delta =
              Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
            event.currentTarget.scrollLeft += delta;
            event.preventDefault();
          }}
        >
          <For each={props.packs}>
            {(pack) => (
              <button
                classList={{ active: pack.id === activePack()?.id }}
                onClick={(event) => {
                  setActivePackId(pack.id);
                  event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'center' });
                }}
                aria-label={pack.title}
                title={pack.title}
              >
                <Show
                  when={pack.id !== 'recent'}
                  fallback={<Clock3 size={19} aria-hidden="true" />}
                >
                  <Show when={pack.stickers[0]}>
                    {(sticker) => (
                      <StickerImage
                        sticker={sticker()}
                        load={() => props.load(sticker())}
                        cachedUrl={() => props.cachedUrl(sticker())}
                        eager
                        label={`${pack.title} icon`}
                      />
                    )}
                  </Show>
                </Show>
              </button>
            )}
          </For>
        </nav>
        <div
          class="sticker-pack-grid"
          aria-label={
            props.query ? 'Sticker search results' : activePack()?.title || 'Sticker pack'
          }
        >
          <For each={results()} fallback={<p>No stickers found</p>}>
            {(sticker) => (
              <button
                class="sticker-option"
                disabled={!props.enabled}
                onClick={() => props.send(sticker)}
                aria-label={`Send ${sticker.emoji} sticker`}
                title={sticker.emoji}
              >
                <StickerImage
                  sticker={sticker}
                  load={() => props.load(sticker)}
                  cachedUrl={() => props.cachedUrl(sticker)}
                />
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
