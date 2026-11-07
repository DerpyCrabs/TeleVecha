import { PollVoters } from './PollVoters';
import type { MediaAssets } from '../media/mediaAssets';
import type { TelegramPollVoter, TelegramPollVotes } from '../../telegram/types';
import { component, list, view } from 'effectweb';
import { Effect } from 'effect';
import Lightbulb from '@effectweb/lucide/icons/lightbulb';
import Check from '@effectweb/lucide/icons/check';
import X from '@effectweb/lucide/icons/x';
import type { TelegramPoll } from '../../telegram/types';
import { pollHasVote, pollIsClosed } from '../../domain/poll';
import { idRows } from '../collections';

interface Props {
  poll: TelegramPoll;
  media: MediaAssets;
  loadVotes: (option?: string, offset?: string) => Effect.Effect<TelegramPollVotes, unknown>;
  openVoter: (person: TelegramPollVoter) => void;
  online: boolean;
  vote: (options: readonly string[]) => Effect.Effect<unknown, unknown>;
}
interface State {
  selected: readonly string[];
  busy: boolean;
  error: string;
  explanation: boolean;
  voters: boolean;
}
type Message =
  | { type: 'Select'; option: string }
  | { type: 'Vote' }
  | { type: 'Explanation' }
  | { type: 'Voters'; open: boolean }
  | { type: 'Done'; error: string };
export const PollCard = component<Props, State, Message>(
  {
    init: () => ({ selected: [], busy: false, error: '', explanation: false, voters: false }),
    update: (model, message) => {
      if (message.type === 'Voters') return { model: { ...model, voters: message.open } };
      if (message.type === 'Explanation')
        return { model: { ...model, explanation: !model.explanation } };
      if (message.type === 'Done')
        return {
          model: {
            ...model,
            busy: false,
            error: message.error,
            selected: message.error ? model.selected : [],
          },
        };
      if (model.busy) return { model };
      const selected =
        message.type === 'Select'
          ? model.props.poll.multipleChoice
            ? model.selected.includes(message.option)
              ? model.selected.filter((option) => option !== message.option)
              : [...model.selected, message.option]
            : [message.option]
          : model.selected;
      if (message.type === 'Select' && model.props.poll.multipleChoice)
        return { model: { ...model, selected } };
      return {
        model: { ...model, selected, busy: true, error: '' },
        commands: [
          {
            key: ['poll', model.props.poll.id],
            policy: 'drop',
            effect: Effect.suspend(() => model.props.vote(selected)).pipe(
              Effect.matchCause({
                onSuccess: () => ({ type: 'Done', error: '' }) as const,
                onFailure: () =>
                  ({ type: 'Done', error: 'Could not submit your vote. Try again.' }) as const,
              }),
            ),
          },
        ],
      };
    },
  },
  view((model, send) => {
    const { poll, online } = model.props,
      closed = pollIsClosed(poll),
      voted = pollHasVote(poll);
    const showResults = (closed || voted) && (!poll.hideResultsUntilClose || closed);
    const canVote = online && !model.busy && !closed && !voted;
    const total = poll.results.totalVoters ?? 0;
    return (
      <section
        class="poll-card"
        aria-label={`${poll.quiz ? 'Quiz' : 'Poll'}: ${poll.question}`}
        aria-busy={model.busy}
      >
        <div class="flex items-start justify-between gap-2">
          <strong class="poll-question">{poll.question}</strong>
          {showResults && poll.quiz && poll.results.solution ? (
            <button
              class="poll-explanation-button"
              title="Show explanation"
              aria-label="Show quiz explanation"
              aria-expanded={model.explanation}
              onClick={() => send({ type: 'Explanation' })}
            >
              <Lightbulb size={20} />
            </button>
          ) : null}
        </div>
        <p class="poll-subtitle">
          {closed
            ? 'Final results'
            : poll.publicVoters
              ? poll.quiz
                ? 'Quiz'
                : 'Public poll'
              : poll.quiz
                ? 'Anonymous quiz'
                : 'Anonymous poll'}
        </p>
        <div class="poll-answers">
          {list(
            idRows(poll.answers.map((answer) => ({ ...answer, id: answer.option }))),
            (answer) => {
              const result = poll.results.answers?.find((item) => item.option === answer.option),
                percent = total
                  ? Math.min(100, Math.round(((result?.voters ?? 0) * 100) / total))
                  : 0;
              const selected = model.selected.includes(answer.option),
                correct = Boolean(poll.quiz && result?.correct),
                wrong = Boolean(poll.quiz && result?.chosen && !result.correct);
              return (
                <button
                  type="button"
                  class={`poll-answer ${showResults ? 'has-results' : ''} ${selected ? 'is-selected' : ''} ${showResults && correct ? 'is-correct' : ''} ${showResults && wrong ? 'is-wrong' : ''}`}
                  aria-pressed={selected || Boolean(result?.chosen)}
                  disabled={!canVote}
                  onClick={() => send({ type: 'Select', option: answer.option })}
                  title={
                    showResults
                      ? `${result?.voters ?? 0} votes${result?.chosen ? ' · Your answer' : ''}${correct ? ' · Correct answer' : ''}`
                      : answer.text
                  }
                >
                  <span class="poll-answer-marker">
                    {showResults ? (
                      <span>{percent}%</span>
                    ) : (
                      <span class="poll-choice-circle">
                        {selected ? <Check size={14} /> : null}
                      </span>
                    )}
                  </span>
                  <span class="poll-answer-content">
                    <span class="poll-answer-label">
                      <span>{answer.text}</span>
                      {showResults && (result?.chosen || correct) ? (
                        <span class="poll-answer-check">
                          {wrong ? <X size={14} /> : <Check size={14} />}
                        </span>
                      ) : null}
                    </span>
                    {showResults ? (
                      <span class="poll-result-track">
                        <span class="poll-result-bar" style={{ width: `${percent}%` }} />
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            },
          )}
        </div>
        {canVote && poll.multipleChoice ? (
          <button
            class="poll-vote-button"
            disabled={!model.selected.length}
            onClick={() => send({ type: 'Vote' })}
          >
            Vote
          </button>
        ) : null}
        {poll.publicVoters && showResults && total > 0 ? (
          <button
            class="poll-vote-button"
            disabled={!online}
            onClick={() => send({ type: 'Voters', open: true })}
          >
            View results
          </button>
        ) : null}
        {model.voters ? (
          <PollVoters
            poll={poll}
            media={model.props.media}
            load={model.props.loadVotes}
            close={() => send({ type: 'Voters', open: false })}
            open={(person) => {
              send({ type: 'Voters', open: false });
              model.props.openVoter(person);
            }}
          />
        ) : null}
        <p class="poll-vote-count">
          {total
            ? `${total} ${poll.quiz ? (total === 1 ? 'answer' : 'answers') : total === 1 ? 'vote' : 'votes'}`
            : poll.quiz
              ? 'No answers yet'
              : 'No votes yet'}
        </p>
        {model.explanation && showResults && poll.results.solution ? (
          <p class="poll-explanation">{poll.results.solution}</p>
        ) : null}
        {model.error ? (
          <p class="mt-2 text-sm" role="alert">
            {model.error}
          </p>
        ) : null}
      </section>
    );
  }),
);
