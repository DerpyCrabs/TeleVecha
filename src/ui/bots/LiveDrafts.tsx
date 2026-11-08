import { list, view } from 'effectweb';
import type { TelegramLiveDraft } from '../../telegram/types';
import { idRows } from '../collections';
import { MessageBody } from '../conversation/MessageBody';
export const LiveDrafts = view<
  { drafts: readonly TelegramLiveDraft[]; onStop?: (id: string) => void },
  never
>((props) => (
  <>
    {list(idRows(props.drafts), (draft) => (
      <div
        class="bot-live-draft"
        data-testid="bot-live-draft"
        data-draft-id={draft.id}
        aria-label="Bot response in progress"
        aria-busy={!draft.stopped}
      >
        {draft.text || draft.richMessage?.blocks.length ? (
          <MessageBody
            botCommands
            message={{
              id: draft.id,
              peerId: draft.peerId,
              author: '',
              body: draft.text,
              time: '',
              outgoing: false,
              status: 'sent',
              formats: draft.formats,
              links: draft.links,
              richMessage: draft.richMessage,
            }}
          />
        ) : (
          <span class="bot-thinking">Thinking…</span>
        )}
        {!draft.stopped ? <span class="bot-streaming-status">Generating…</span> : null}
        {draft.canStop && props.onStop ? (
          <button type="button" class="bot-stop-draft" onClick={() => props.onStop!(draft.id)}>
            Stop generating
          </button>
        ) : null}
      </div>
    ))}
  </>
));
