import { component, view } from 'effectweb';
import { Effect } from 'effect';
import type { TelegramContact } from '../../telegram/types';
import { contactName, contactVcard } from '../../domain/contact';
import { telegramPeerColor } from '../../domain/peerColor';
import { Avatar } from '../shared/Avatar';
import type { MediaAssets } from '../media/mediaAssets';

interface Props {
  contact: TelegramContact;
  media: MediaAssets;
  online: boolean;
  protected: boolean;
  open: (contact: TelegramContact) => Promise<unknown>;
  add: (contact: TelegramContact) => Promise<unknown>;
}
type Message = { type: 'Action'; action: 'open' | 'add' } | { type: 'Done'; status: string };
export const ContactCard = component<Props, { busy: boolean; status: string }, Message>(
  {
    init: () => ({ busy: false, status: '' }),
    update: (model, message) => {
      if (message.type === 'Done')
        return { model: { ...model, busy: false, status: message.status } };
      if (model.busy) return { model };
      const { contact } = model.props;
      return {
        model: { ...model, busy: true, status: '' },
        commands: [
          {
            key: ['contact', contact.phoneNumber],
            policy: 'drop',
            effect: Effect.tryPromise({
              try: () => model.props[message.action](contact),
              catch: (error) => error,
            }).pipe(
              Effect.matchCause({
                onSuccess: () =>
                  ({
                    type: 'Done',
                    status: message.action === 'add' ? 'Contact added' : '',
                  }) as const,
                onFailure: () =>
                  ({
                    type: 'Done',
                    status: 'Could not complete this action. Please try again.',
                  }) as const,
              }),
            ),
          },
        ],
      };
    },
  },
  view((model, send) => {
    const contact = model.props.contact;
    const name = contactName(contact);
    const peer = contact.peer;
    const phone = contact.phoneNumber.replace(/[^+\d]/gu, '');
    return (
      <section class="contact-card" aria-label={`Contact: ${name}`}>
        <div class="flex min-w-0 items-center gap-3">
          <Avatar
            identity={`contact:${peer?.id ?? contact.phoneNumber}:${contact.avatarId ?? ''}`}
            initials={name
              .split(/\s+/u)
              .slice(0, 2)
              .map((part) => part[0])
              .join('')
              .toLocaleUpperCase()}
            color={telegramPeerColor(peer?.id ?? contact.phoneNumber)}
            loadCached={
              peer && contact.hasAvatar
                ? () => model.props.media.loadPeerAvatar(peer, true, contact.avatarId, true)
                : undefined
            }
            load={
              peer && contact.hasAvatar && model.props.online
                ? () => model.props.media.loadPeerAvatar(peer, true, contact.avatarId)
                : undefined
            }
          />
          <div class="min-w-0 flex-1">
            <strong class="block break-words" title={name}>
              {name}
            </strong>
            <a
              class="block break-all text-sm text-accent"
              href={`tel:${phone}`}
              title="Call this number"
            >
              {contact.phoneNumber}
            </a>
          </div>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          {peer ? (
            <button
              type="button"
              class="contact-card-action"
              disabled={model.busy || !model.props.online}
              onClick={() => send({ type: 'Action', action: 'open' })}
            >
              Open chat
            </button>
          ) : null}
          {peer && !model.props.protected ? (
            <button
              type="button"
              class="contact-card-action"
              disabled={model.busy || !model.props.online}
              onClick={() => send({ type: 'Action', action: 'add' })}
            >
              Add contact
            </button>
          ) : null}
          {!model.props.protected ? (
            <a
              class="contact-card-action"
              href={`data:text/vcard;charset=utf-8,${encodeURIComponent(contactVcard(contact))}`}
              download="contact.vcf"
              title="Save to your address book"
            >
              Save contact
            </a>
          ) : null}
        </div>
        {model.status ? (
          <p class="mt-2 text-xs" role="status">
            {model.status}
          </p>
        ) : null}
      </section>
    );
  }),
);
