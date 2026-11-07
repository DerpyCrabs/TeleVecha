import { Effect } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { available, component, domBinding, list, resourceError, view } from 'effectweb';
import type { TelegramPoll, TelegramPollVoter, TelegramPollVotes } from '../../telegram/types';
import type { MediaAssets } from '../media/mediaAssets';
import { Dialog } from '../shared/Dialog';
import { Avatar } from '../shared/Avatar';
import { idRows } from '../collections';

interface Props {
  poll: TelegramPoll;
  media: MediaAssets;
  load: (option?: string, offset?: string) => Effect.Effect<TelegramPollVotes, unknown>;
  open: (person: TelegramPollVoter) => void;
  close: () => void;
}
function acquire(_element: HTMLElement, input: () => { id: string; load: () => void }) {
  let loaded = '';
  const update = () => {
    if (loaded === input().id) return;
    loaded = input().id;
    input().load();
  };
  update();
  return { update, dispose() {} };
}
export const PollVoters = component(
  {
    identity: (props) => props.poll.id,
    init: (_props: Props) => ({
      option: '',
      page: AsyncResult.initial() as AsyncResult.AsyncResult<TelegramPollVotes, unknown>,
    }),
  },
  (owner) =>
    view((model) => {
      const props = model.props;
      const page = available(model.page);
      const load = (option: string, offset?: string) => {
        const previous = offset ? (page?.people ?? []) : [];
        if (!offset) owner.patch({ option, page: AsyncResult.initial() });
        owner.task(
          'page',
          props
            .load(option || undefined, offset)
            .pipe(
              Effect.map((next) => ({
                ...next,
                people: [
                  ...new Map(
                    [...previous, ...next.people].map((person) => [person.id, person]),
                  ).values(),
                ],
              })),
            ),
          'replace',
        );
      };
      return (
        <Dialog title="Poll results" class="poll-voters-dialog" onClose={props.close}>
          <span hidden use={domBinding({ id: props.poll.id, load: () => load('') }, acquire)} />
          <p class="poll-voters-question">{props.poll.question}</p>
          <nav class="poll-voters-options" aria-label="Filter poll results">
            <button aria-pressed={!model.option} onClick={() => load('')}>
              All votes
            </button>
            {list(
              idRows(props.poll.answers.map((answer) => ({ ...answer, id: answer.option }))),
              (answer) => (
                <button
                  title={answer.text}
                  aria-pressed={model.option === answer.option}
                  onClick={() => load(answer.option)}
                >
                  {answer.text}
                </button>
              ),
            )}
          </nav>
          <div class="poll-voters-list">
            {list(idRows(page?.people ?? []), (person) => (
              <button
                class="read-receipt-person"
                onClick={() => props.open(person)}
                disabled={person.peer.kind !== 'group' && !person.peer.accessHash}
                title={person.name}
              >
                <Avatar
                  identity={`${person.id}:${person.avatarId ?? ''}`}
                  initials={person.initials}
                  color={person.color}
                  size="sm"
                  loadCached={
                    person.hasAvatar
                      ? () => props.media.loadPeerAvatar(person.peer, true, person.avatarId, true)
                      : undefined
                  }
                  load={
                    person.hasAvatar
                      ? () => props.media.loadPeerAvatar(person.peer, true, person.avatarId)
                      : undefined
                  }
                />
                <span>
                  <strong>{person.name}</strong>
                  <small>
                    {person.options
                      .map(
                        (option) =>
                          props.poll.answers.find((answer) => answer.option === option)?.text,
                      )
                      .filter(Boolean)
                      .join(', ')}
                  </small>
                </span>
              </button>
            ))}
            {model.page.waiting ? <p role="status">Loading votes…</p> : null}
            {resourceError(model.page) ? (
              <p role="alert">
                Could not load votes.{' '}
                <button onClick={() => load(model.option, page?.nextOffset)}>Try again</button>
              </p>
            ) : null}
            {page?.unavailable ? (
              <p role="status">
                {page.unavailable === 'broadcast'
                  ? 'Telegram does not disclose voters in this channel.'
                  : page.unavailable === 'vote-required'
                    ? 'Vote in this poll to see who voted.'
                    : 'This poll is no longer available.'}
              </p>
            ) : null}
            {page && !page.unavailable && !page.people.length && !model.page.waiting ? (
              <p>No votes for this option.</p>
            ) : null}
            {page?.nextOffset && !resourceError(model.page) ? (
              <button
                class="poll-voters-more"
                disabled={model.page.waiting}
                onClick={() => load(model.option, page.nextOffset)}
              >
                Show more votes
              </button>
            ) : null}
          </div>
        </Dialog>
      );
    }),
);
