import { commandSlot } from 'effectweb';
import { effectCommand } from 'effectweb/program';
import { cachedLoad } from 'effectweb/load';
import { component, domBinding, view } from 'effectweb';
import type { Send, Transition } from 'effectweb/program';
import type { UiLoad } from 'effectweb/cache';
import { TgsPlayer } from './TgsPlayer';
import { VisibilityVideo } from './VisibilityVideo';
const commandAsset = commandSlot('asset');

interface Props {
  identity: string;
  mimeType: string;
  label?: string | undefined;
  placeholder: string;
  load: () => UiLoad<string | undefined>;
  cachedUrl: () => string | undefined;
  eager?: boolean | undefined;
  rootSelector?: string | undefined;
  class?: string | undefined;
}
interface Model {
  props: Props;
  visible: boolean;
  requested: string | undefined;
  source: string | undefined;
}
type Message = { type: 'Visible' } | { type: 'Loaded'; source: string | undefined };
function request(model: Model): Transition<Model, Message> {
  if (!model.visible || model.requested === model.props.identity) return { model };
  const props = model.props;
  return {
    model: { ...model, requested: props.identity, source: undefined },
    commands: [
      effectCommand(commandAsset, () => cachedLoad(props.cachedUrl, props.load), {
        policy: 'replace',
        onSuccess: (source) => ({ type: 'Loaded', source }) as const,
        onFailure: () => ({ type: 'Loaded', source: undefined }) as const,
      }),
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
export const LazyMedia = component<Props, Model, Message>({
  init: (props) => ({
    props,
    visible: Boolean(props.eager),
    requested: undefined,
    source: undefined,
  }),
  receive: (model, props) =>
    request({
      ...model,
      props,
      visible: model.visible || Boolean(props.eager),
      source: props.identity === model.props.identity ? model.source : undefined,
    }),
  update: (model, message) =>
    message.type === 'Visible'
      ? request({ ...model, visible: true })
      : { model: { ...model, source: message.source } },
  view: view((model, send) => (
    <span
      class={model.props.class}
      use={domBinding({ send, root: model.props.rootSelector }, observe)}
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
});
