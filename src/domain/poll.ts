import type { TelegramPollDraft } from '../telegram/types';
import type { TelegramPoll, TelegramPollResults } from '../telegram/types';

export const pollOptionKey = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
export function pollOptionBytes(key: string) {
  if (!/^(?:[a-f0-9]{2})+$/iu.test(key)) throw new Error('Invalid poll option.');
  return Uint8Array.from(key.match(/../gu)!, (value) => Number.parseInt(value, 16));
}
export function mergePollResults(
  previous: TelegramPollResults,
  next: TelegramPollResults,
): TelegramPollResults {
  return {
    ...previous,
    ...next,
    totalVoters: next.totalVoters ?? previous.totalVoters,
    solution: next.solution ?? previous.solution,
    answers:
      next.answers?.map((answer) => {
        const old = previous.answers?.find((item) => item.option === answer.option);
        return next.min ? { ...answer, chosen: old?.chosen, correct: old?.correct } : answer;
      }) ?? previous.answers,
  };
}
export const pollHasVote = (poll: TelegramPoll) =>
  Boolean(poll.results.answers?.some((answer) => answer.chosen));
export const pollIsClosed = (poll: TelegramPoll, now = Date.now()) =>
  poll.closed || Boolean(poll.closeDate && poll.closeDate * 1000 <= now);

export function pollDraftError(draft: TelegramPollDraft): string | undefined {
  if (!draft.question.trim() || draft.question.length > 255)
    return 'Enter a question of up to 255 characters.';
  if (
    draft.answers.length < 2 ||
    draft.answers.length > 10 ||
    draft.answers.some((answer) => !answer.trim() || answer.length > 100)
  )
    return 'Add 2–10 answers, each up to 100 characters.';
  if (
    draft.quiz &&
    (draft.multipleChoice ||
      !Number.isInteger(draft.correctAnswer) ||
      draft.correctAnswer! < 0 ||
      draft.correctAnswer! >= draft.answers.length)
  )
    return 'Choose the correct quiz answer.';
  if (draft.solution.length > 200 || (draft.solution.match(/\n/gu)?.length ?? 0) > 2)
    return 'Use up to 200 characters and 2 line breaks for the explanation.';
  return undefined;
}
export function pendingPoll(draft: TelegramPollDraft, id: string): TelegramPoll {
  return {
    id,
    hash: '0',
    question: draft.question,
    answers: draft.answers.map((text, index) => ({
      text,
      option: pollOptionKey(new Uint8Array([index])),
    })),
    closed: false,
    publicVoters: draft.publicVoters,
    multipleChoice: draft.multipleChoice,
    quiz: draft.quiz,
    revotingDisabled: draft.quiz,
    hideResultsUntilClose: false,
    results: { totalVoters: 0 },
  };
}
