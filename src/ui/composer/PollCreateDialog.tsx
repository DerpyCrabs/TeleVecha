import { component, list, Portal, view } from 'effectweb';
import { Effect } from 'effect';
import type { TelegramPollDraft } from '../../telegram/types';
import { pollDraftError } from '../../domain/poll';
import { idRows } from '../collections';
import { modalMount } from '../shared/modalMount';
import X from '@effectweb/lucide/icons/x';

interface Props {
  close: () => void;
  submit: (draft: TelegramPollDraft) => Effect.Effect<unknown, unknown>;
}
interface State {
  question: string;
  answers: { id: string; text: string }[];
  nextId: number;
  anonymous: boolean;
  multiple: boolean;
  quiz: boolean;
  correctId: string;
  solution: string;
  busy: boolean;
  error: string;
}
type Message =
  | { type: 'Field'; field: 'question' | 'correctId' | 'solution'; value: string }
  | { type: 'Toggle'; field: 'anonymous' | 'multiple' | 'quiz'; value: boolean }
  | { type: 'Answer'; id: string; text: string }
  | { type: 'Remove'; id: string }
  | { type: 'Submit' }
  | { type: 'Failed'; error: string };
const draftFor = (model: State): TelegramPollDraft => ({
  question: model.question.trim(),
  answers: model.answers.filter((answer) => answer.text.trim()).map((answer) => answer.text.trim()),
  publicVoters: !model.anonymous,
  multipleChoice: model.multiple,
  quiz: model.quiz,
  ...(model.quiz
    ? {
        correctAnswer: model.answers
          .filter((answer) => answer.text.trim())
          .findIndex((answer) => answer.id === model.correctId),
      }
    : {}),
  solution: model.quiz ? model.solution.trim() : '',
});
export const PollCreateDialog = component<Props, State, Message>(
  {
    init: () => ({
      question: '',
      answers: [
        { id: '0', text: '' },
        { id: '1', text: '' },
      ],
      nextId: 2,
      anonymous: true,
      multiple: false,
      quiz: false,
      correctId: '',
      solution: '',
      busy: false,
      error: '',
    }),
    update: (model, message) => {
      if (message.type === 'Failed')
        return { model: { ...model, busy: false, error: message.error } };
      if (model.busy) return { model };
      if (message.type === 'Field')
        return { model: { ...model, [message.field]: message.value, error: '' } };
      if (message.type === 'Toggle')
        return {
          model: {
            ...model,
            [message.field]: message.value,
            ...(message.field === 'quiz' && message.value ? { multiple: false } : {}),
            error: '',
          },
        };
      if (message.type === 'Answer') {
        const append =
          message.text.trim() &&
          model.answers.at(-1)?.id === message.id &&
          model.answers.length < 10;
        return {
          model: {
            ...model,
            answers: [
              ...model.answers.map((answer) =>
                answer.id === message.id ? { ...answer, text: message.text } : answer,
              ),
              ...(append ? [{ id: String(model.nextId), text: '' }] : []),
            ],
            nextId: model.nextId + (append ? 1 : 0),
            error: '',
          },
        };
      }
      if (message.type === 'Remove')
        return model.answers.length <= 2
          ? { model }
          : {
              model: {
                ...model,
                answers: model.answers.filter((answer) => answer.id !== message.id),
                correctId: model.correctId === message.id ? '' : model.correctId,
              },
            };
      const draft = draftFor(model),
        error = pollDraftError(draft);
      if (error) return { model: { ...model, error } };
      return {
        model: { ...model, busy: true, error: '' },
        commands: [
          {
            key: 'send-poll',
            policy: 'drop',
            effect: Effect.suspend(() => model.props.submit(draft)).pipe(
              Effect.flatMap(() => Effect.sync(() => model.props.close())),
              Effect.matchCause({
                onSuccess: () => ({ type: 'Failed', error: '' }) as const,
                onFailure: () =>
                  ({
                    type: 'Failed',
                    error: 'Could not send the poll. Please try again.',
                  }) as const,
              }),
            ),
          },
        ],
      };
    },
  },
  view((model, send) => (
    <Portal>
      <div class="forward-overlay">
        <section
          class="poll-create-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="poll-create-title"
          use={modalMount(model.props.close)}
        >
          <header class="flex items-center justify-between gap-3">
            <h2 id="poll-create-title" class="text-lg font-semibold">
              {model.quiz ? 'New Quiz' : 'New Poll'}
            </h2>
            <button
              type="button"
              class="icon-button"
              aria-label="Cancel poll"
              title="Cancel poll"
              onClick={model.props.close}
            >
              <X size={20} />
            </button>
          </header>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              send({ type: 'Submit' });
            }}
            class="poll-create-form"
          >
            <div class="poll-create-fields">
              <label class="grid gap-2 text-sm">
                Question
                <textarea
                  autofocus
                  required
                  maxlength={255}
                  rows={2}
                  value={model.question}
                  disabled={model.busy}
                  onInput={(event) =>
                    send({ type: 'Field', field: 'question', value: event.currentTarget.value })
                  }
                />
              </label>
              <fieldset disabled={model.busy} class="grid gap-2">
                <legend class="mb-2 text-sm">
                  Answers{model.quiz ? ' · Select the correct answer' : ''}
                </legend>
                {list(idRows(model.answers), (answer, index) => (
                  <div class="flex items-center gap-2">
                    {model.quiz ? (
                      <input
                        type="radio"
                        name="correct-answer"
                        disabled={!answer.text.trim()}
                        aria-label={`Answer ${index + 1} is correct`}
                        checked={model.correctId === answer.id}
                        onChange={() =>
                          send({ type: 'Field', field: 'correctId', value: answer.id })
                        }
                      />
                    ) : null}
                    <input
                      class="min-w-0 flex-1"
                      aria-label={`Answer ${index + 1}`}
                      placeholder={`Answer ${index + 1}`}
                      maxlength={100}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229)
                          return;
                        event.preventDefault();
                        const field = event.currentTarget;
                        const fields = [
                          ...(field
                            .closest('fieldset')
                            ?.querySelectorAll<HTMLInputElement>('input:not([type=radio])') ?? []),
                        ];
                        fields[fields.indexOf(field) + 1]?.focus();
                      }}
                      value={answer.text}
                      onInput={(event) =>
                        send({ type: 'Answer', id: answer.id, text: event.currentTarget.value })
                      }
                    />
                    <button
                      type="button"
                      class="icon-button"
                      title={`Remove answer ${index + 1}`}
                      aria-label={`Remove answer ${index + 1}`}
                      disabled={model.answers.length <= 2}
                      hidden={
                        model.answers.length <= 2 ||
                        (!answer.text && index === model.answers.length - 1)
                      }
                      onClick={() => send({ type: 'Remove', id: answer.id })}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </fieldset>
              <fieldset disabled={model.busy} class="grid gap-3 text-sm">
                <label class="poll-setting">
                  <input
                    type="checkbox"
                    checked={model.anonymous}
                    onChange={(event) =>
                      send({
                        type: 'Toggle',
                        field: 'anonymous',
                        value: event.currentTarget.checked,
                      })
                    }
                  />
                  Anonymous voting
                </label>
                <label class="poll-setting">
                  <input
                    type="checkbox"
                    checked={model.multiple}
                    disabled={model.quiz}
                    onChange={(event) =>
                      send({
                        type: 'Toggle',
                        field: 'multiple',
                        value: event.currentTarget.checked,
                      })
                    }
                  />
                  Multiple answers
                </label>
                <label class="poll-setting">
                  <input
                    type="checkbox"
                    checked={model.quiz}
                    onChange={(event) =>
                      send({ type: 'Toggle', field: 'quiz', value: event.currentTarget.checked })
                    }
                  />
                  Quiz mode
                </label>
              </fieldset>
              {model.quiz ? (
                <label class="grid gap-2 text-sm">
                  Explanation (optional)
                  <textarea
                    maxlength={200}
                    rows={2}
                    value={model.solution}
                    disabled={model.busy}
                    onInput={(event) =>
                      send({ type: 'Field', field: 'solution', value: event.currentTarget.value })
                    }
                  />
                </label>
              ) : null}
              {model.error ? (
                <p class="text-sm" role="alert">
                  {model.error}
                </p>
              ) : null}
            </div>
            <div class="poll-dialog-actions">
              <button type="button" disabled={model.busy} onClick={model.props.close}>
                Cancel
              </button>
              <button type="submit" disabled={model.busy}>
                {model.busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </section>
      </div>
    </Portal>
  )),
);
