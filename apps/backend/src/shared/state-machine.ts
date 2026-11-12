import { AppError } from './errors/app-error.js';

/**
 * Explicit state machine: the only way domain statuses change. `transitions[from]` lists the
 * allowed targets; everything else is rejected with 409 INVALID_TRANSITION.
 */
export interface StateMachine<S extends string> {
  readonly transitions: Readonly<Record<S, readonly S[]>>;
  can(from: S, to: S): boolean;
  assert(from: S, to: S): void;
}

export function defineStateMachine<S extends string>(
  entity: string,
  transitions: Readonly<Record<S, readonly S[]>>,
): StateMachine<S> {
  return {
    transitions,
    can: (from, to) => transitions[from].includes(to),
    assert(from, to) {
      if (!transitions[from].includes(to)) {
        throw new AppError(
          409,
          'INVALID_TRANSITION',
          `${entity} cannot change from ${from} to ${to}`,
          {
            details: { entity, from, to },
          },
        );
      }
    },
  };
}
