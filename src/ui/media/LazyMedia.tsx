import { Effect } from 'effect';
import { component, domBinding, view } from 'effectweb';
import { cachedLoad } from '../shared/cachedLoad';
import type { Send, Transition } from 'effectweb';
import { TgsPlayer } from './TgsPlayer';
import { VisibilityVideo } from './VisibilityVideo';
const commandAsset = 'asset';

interface Props {
  identity: string;
  mimeType: string;
  label?: string | undefined;
  placeholder: string;
  load: () => Effect.Effect<string | undefined, unknown>;
  cachedUrl: () => string | undefined;
  eager?: boolean | undefined;
  rootSelector?: string | undefined;
  class?: string | undefined;
}
interface State {
  visible: boolean;
  requested: string | undefined;
  source: string | undefined;
}
type Model = State & { readonly props: Props };
type Message = { type: 'Visible' } | { type: 'Loaded'; source: string | undefined };
function request(model: Model): Transition<Model, Message> {
  if (!model.visible || model.requested === model.props.identity) return { model };
  const props = model.props;
  return {
    model: { ...model, requested: props.identity, source: undefined },
    commands: [
      {
        key: commandAsset,
        policy: 'replace',
        effect: cachedLoad(props.cachedUrl, props.load).pipe(
          Effect.matchCause({
            onSuccess: (source) => ({ type: 'Loaded', source }) as const,
            onFailure: () => ({ type: 'Loaded', source: undefined }) as const,
          }),
        ),
      },
    ],
  };
}
function observe(
  element: HTMLElement,
  input: () => { send: Send<Message>; root: string | undefined },
) {
  if (!('IntersectionObserver' in window)) {
    input().send({ type: 'Visible' });
    return () => undefined;
  }
  const root = input().root;
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      input().send({ type: 'Visible' });
    },
    { root: root ? element.closest(root) : null, rootMargin: '120px' },
  );
  observer.observe(element);
  return () => observer.disconnect();
}
export const LazyMedia = component<Props, State, Message>(
  {
    init: (props) => ({ visible: Boolean(props.eager), requested: undefined, source: undefined }),
    receive: (model, previous) =>
      request({
        ...model,
        visible: model.visible || Boolean(model.props.eager),
        source: model.props.identity === previous.identity ? model.source : undefined,
      }),
    update: (model, message) =>
      message.type === 'Visible'
        ? request({ ...model, visible: true })
        : { model: { ...model, source: message.source } },
  },
  view((model, send) => (
    <span
      class={model.props.class}
      use={domBinding({ send, root: model.props.rootSelector }, observe, {
        identity: model.props.rootSelector,
      })}
    >
      {model.source ? (
        model.props.mimeType === 'application/x-tgsticker' ? (
          <TgsPlayer
            source={model.source}
            label={model.props.label ?? `${model.props.placeholder} animated sticker`}
          />
        ) : model.props.mimeType.startsWith('video/') ? (
          <VisibilityVideo source={model.source} label={model.props.label} />
        ) : (
          <img draggable={false} src={model.source} alt="" />
        )
      ) : (
        <span class={model.props.placeholder === 'GIF' ? 'gif-placeholder' : 'sticker-placeholder'}>
          {model.props.placeholder}
        </span>
      )}
    </span>
  )),
);
