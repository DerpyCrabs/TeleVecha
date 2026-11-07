import { MediaAttachment } from '../media/MediaAttachment';
import type { MediaAssets } from '../media/mediaAssets';
import type { TelegramPeer, TelegramMessage } from '../../telegram/types';
import { panelClass } from '../shared/panelStyles';
import { component, list, view } from 'effectweb';
import Forward from '@effectweb/lucide/icons/forward';
import X from '@effectweb/lucide/icons/x';
import type { ChatMessage } from '../../domain/models';
import type { TelegramForwardOptions } from '../../telegram/types';
import { Dialog } from '../shared/Dialog';
import { idRows } from '../collections';
export interface ForwardDraftProps {
  messages: ChatMessage[];
  source: TelegramPeer;
  media: MediaAssets;
  options: TelegramForwardOptions;
  busy: boolean;
  error: string;
  cancel: () => void;
  changeRecipient: () => void;
  remove: (id: string) => void;
  configure: (options: TelegramForwardOptions) => void;
}
export const ForwardDraft = component<ForwardDraftProps, { open: boolean }, boolean>(
  { init: () => ({ open: false }), update: (model, open) => ({ model: { ...model, open } }) },
  view((model, send) => {
    const props = model.props;
    const names = [
      ...new Set(props.messages.map((message) => message.forwardedFrom?.name ?? message.author)),
    ].join(', ');
    return (
      <>
        <div class="composer-forward">
          <Forward size={20} />
          <button
            class="composer-forward-summary"
            onClick={() => send(true)}
            disabled={props.busy}
            aria-label="Forwarding options"
          >
            <strong>
              {props.messages.length === 1
                ? 'Forward message'
                : `Forward ${props.messages.length} messages`}
            </strong>
            <small>{props.options.hideAuthor ? 'Sender names hidden' : names}</small>
          </button>
          <button
            class="composer-icon-button"
            onClick={props.cancel}
            disabled={props.busy}
            aria-label="Cancel forwarding"
          >
            <X size={18} />
          </button>
        </div>
        {props.error ? (
          <p class="composer-forward-error" role="alert">
            {props.error}
          </p>
        ) : null}
        {model.open ? (
          <Dialog
            class={`${panelClass} forward-draft-dialog`}
            title="Forward messages"
            label="Forwarding options"
            onClose={() => send(false)}
          >
            <div class="forward-draft-preview">
              {list(idRows(props.messages), (message) => (
                <div class="forward-draft-message">
                  <button
                    class="forward-draft-remove"
                    aria-label={`Remove message ${message.id} from forwarding`}
                    title="Remove from forwarding"
                    onClick={() => props.remove(message.id)}
                  >
                    <X size={16} />
                  </button>
                  {!props.options.hideAuthor ? (
                    <strong>Forwarded from {message.forwardedFrom?.name ?? message.author}</strong>
                  ) : null}
                  {message.media
                    ? (() => {
                        const source: TelegramMessage = {
                          id: Number(message.id),
                          peerId: props.source.id,
                          peer: props.source,
                          senderId: message.senderId ?? '',
                          text: message.body,
                          date: message.date ?? 0,
                          outgoing: message.outgoing,
                          media: message.media,
                        };
                        const asset = props.media.message(source);
                        const preview = props.media.messagePreview(source);
                        return (
                          <MediaAttachment
                            media={message.media!}
                            compact
                            decorative
                            revision={asset.revision}
                            load={(progress) => asset.load(progress)}
                            cachedUrl={() => asset.cached()}
                            loadPreview={preview.load}
                            cachedPreviewUrl={preview.cached}
                          />
                        );
                      })()
                    : null}
                  {!(props.options.hideCaption && message.media) ? (
                    <p>
                      {message.body ||
                        (message.poll ? message.poll.question : message.contact ? 'Contact' : '')}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
            <div class="forward-draft-options">
              <label>
                <input
                  type="checkbox"
                  checked={!!props.options.hideAuthor}
                  onChange={(event) =>
                    props.configure({
                      hideAuthor: event.currentTarget.checked,
                      hideCaption: event.currentTarget.checked && props.options.hideCaption,
                    })
                  }
                />{' '}
                Hide sender names
              </label>
              {props.messages.some((message) => message.media && message.body) ? (
                <label>
                  <input
                    type="checkbox"
                    checked={!!props.options.hideCaption}
                    onChange={(event) =>
                      props.configure({
                        hideCaption: event.currentTarget.checked,
                        hideAuthor: event.currentTarget.checked || props.options.hideAuthor,
                      })
                    }
                  />{' '}
                  Hide captions
                </label>
              ) : null}
              <button
                class="forward-change-recipient"
                onClick={() => {
                  send(false);
                  props.changeRecipient();
                }}
              >
                Change recipient
              </button>
              <button class="primary" onClick={() => send(false)}>
                Done
              </button>
            </div>
          </Dialog>
        ) : null}
      </>
    );
  }),
);
