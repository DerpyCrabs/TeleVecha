// Small composition utilities that used to ship in effectweb/advanced. They are ordinary
// application code: message creators for a reducer, shallow patches, memoized selectors over
// one explicit version, and a group of owned sessions.
import { modelOwner, type Send, type Transition } from 'effectweb';

type Handler<Model, R> = (model: Model, ...args: never[]) => Transition<Model, unknown, R>;
type Arguments<F> = F extends (model: never, ...args: infer Args) => unknown ? Args : never;
type HandlerMessage<Handlers> = {
  [Name in keyof Handlers]: { readonly type: Name; readonly args: Arguments<Handlers[Name]> };
}[keyof Handlers];
export type ActionMessage<Definition> = Definition extends {
  update: (model: never, message: infer Message) => unknown;
}
  ? Message
  : never;
type Creators<Handlers> = {
  [Name in keyof Handlers]: (
    ...args: Arguments<Handlers[Name]>
  ) => Extract<HandlerMessage<Handlers>, { type: Name }>;
};
type Dispatch<Handlers> = {
  [Name in keyof Handlers]: (...args: Arguments<Handlers[Name]>) => void;
};

/** Named reducer handlers with typed message creators and a dispatcher bound to `send`. */
export function defineActions<Model, R = never>() {
  return <Handlers extends Record<string, Handler<Model, R>>>(handlers: Handlers) => {
    type Message = HandlerMessage<Handlers>;
    const message = Object.create(null) as Creators<Handlers>;
    for (const name of Object.keys(handlers) as (keyof Handlers)[]) {
      Object.defineProperty(message, name, {
        enumerable: true,
        value: (...args: unknown[]) => ({ type: name, args }),
      });
    }
    return {
      message,
      bind(this: void, send: Send<Message>): Dispatch<Handlers> {
        const dispatch = Object.create(null) as Dispatch<Handlers>;
        for (const name of Object.keys(handlers) as (keyof Handlers)[]) {
          Object.defineProperty(dispatch, name, {
            enumerable: true,
            value: (...args: unknown[]) => send({ type: name, args } as Message),
          });
        }
        return dispatch;
      },
      update(this: void, model: Model, action: Message): ReturnType<Handlers[keyof Handlers]> {
        if (!Object.hasOwn(handlers, action.type))
          throw new Error(`Unknown action: ${String(action.type)}`);
        const handler = handlers[action.type] as (
          model: Model,
          ...args: unknown[]
        ) => ReturnType<Handlers[keyof Handlers]>;
        // oxlint-disable-next-line typescript/no-unsafe-return -- The indexed handler and ReturnType refer to the same validated generic member.
        return handler(model, ...action.args);
      },
    };
  };
}

/** A shallow patch that keeps the model's identity when no field changes. */
export function patchModel<Model extends object>(
  model: Model,
  patch: Partial<NoInfer<Model>>,
): Model {
  return (Reflect.ownKeys(patch) as (keyof Model)[]).some(
    (key) =>
      Object.prototype.propertyIsEnumerable.call(patch, key) &&
      (!Object.hasOwn(model, key) || !Object.is(model[key], patch[key])),
  )
    ? { ...model, ...patch }
    : model;
}

/** Selectors computed once per explicit invalidation, with the previous output available. */
export function projectionCache() {
  let version = 0;
  function select<A>(compute: (previous: A) => A, initial: A): () => A;
  function select<A>(compute: (previous: A | undefined) => A): () => A;
  function select<A>(compute: (previous: A | undefined) => A, initial?: A): () => A {
    let seen = -1,
      value = initial;
    return () => {
      if (seen !== version) {
        value = compute(value);
        seen = version;
      }
      return value!;
    };
  }
  return {
    invalidate: () => {
      version++;
    },
    select,
  };
}

interface OwnedSession {
  dispose(): void;
  refresh?(): void;
  subscribe?(changed: () => void): () => void;
}
/** Own several sessions together: one `changed` subscription, one refresh, one dispose. */
export function sessionGroup(sessions: readonly OwnedSession[], changed: () => void) {
  const scope = modelOwner({});
  for (const session of sessions) scope.own(() => session.dispose());
  try {
    for (const session of sessions) {
      if (session.subscribe) scope.own(session.subscribe(changed));
    }
  } catch (error) {
    scope.dispose();
    throw error;
  }
  return {
    refresh: () => {
      if (scope.disposed) {
        return;
      }
      const errors: unknown[] = [];
      for (const session of sessions) {
        try {
          session.refresh?.();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) console.error(new AggregateError(errors, 'Session refresh failed'));
    },
    dispose: () => scope.dispose(),
  };
}
