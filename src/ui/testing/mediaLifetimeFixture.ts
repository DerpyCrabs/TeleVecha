import { Effect } from 'effect';
import { modelOwner, mountView, type View } from 'effectweb';
import { ImageAttachmentEditor } from '../composer/ImageAttachmentEditor';
import { MediaAttachment } from '../media/MediaAttachment';
import { TgsPlayer } from '../media/TgsPlayer';
import { Avatar } from '../shared/Avatar';

function mount<Props extends object>(
  parent: HTMLElement,
  definition: View<Props, never>,
  initial: Props,
) {
  const owner = modelOwner(initial);
  const unmount = mountView(parent, definition, owner.source);
  return {
    patch: owner.patch,
    close: () => Effect.runPromise(unmount.close().pipe(Effect.onExit(() => owner.close()))),
  };
}

export function mountAvatarLifetimeFixture(parent: HTMLElement) {
  return mount(parent, Avatar, { identity: 'avatar', initials: 'A', color: '#123456' });
}

export function mountTgsLifetimeFixture(parent: HTMLElement) {
  return mount(parent, TgsPlayer, { source: '/lifetime-first.tgs', label: 'First animation' });
}

export function mountImageLifetimeFixture(parent: HTMLElement) {
  const attachment = {
    id: 'image',
    file: new File(['first'], 'first.png', { type: 'image/png' }),
    sendAs: 'media' as const,
  };
  const mounted = mount(parent, ImageAttachmentEditor, {
    attachment,
    close: () => {},
    apply: () => {},
  });
  return {
    ...mounted,
    replace: () =>
      mounted.patch({
        attachment: {
          ...attachment,
          file: new File(['second'], 'second.png', { type: 'image/png' }),
        },
      }),
  };
}

export function mountVideoLifetimeFixture(parent: HTMLElement) {
  return mount(parent, MediaAttachment, {
    media: { kind: 'video', name: 'video.mp4', mimeType: 'video/mp4', size: 1 },
    load: () => Effect.succeed('/lifetime-video.mp4'),
    loadPreview: () => Effect.succeed('/lifetime-preview.png'),
  });
}
