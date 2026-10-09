import { InvalidStateTransitionError } from './application.errors';
import { ApplicationStatus as S } from './enums/application-status.enum';

/**
 * The ONLY place that defines which status changes are valid.
 *
 * Who may trigger a transition (SALES submits, ADMIN assigns, the assigned
 * REVIEWER decides) is a separate concern, handled by the policy layer.
 *
 *   DRAFT ─► SUBMITTED ─► IN_REVIEW ─┬─► APPROVED   (terminal)
 *               ▲                    ├─► REJECTED   (terminal)
 *               │                    │
 *               └──── INFO_REQUESTED ◄┘
 */
const TRANSITIONS: Readonly<Record<S, readonly S[]>> = {
  [S.DRAFT]: [S.SUBMITTED],
  [S.SUBMITTED]: [S.IN_REVIEW],
  [S.IN_REVIEW]: [S.APPROVED, S.REJECTED, S.INFO_REQUESTED],
  [S.INFO_REQUESTED]: [S.SUBMITTED],
  [S.APPROVED]: [],
  [S.REJECTED]: [],
};

/** Statuses in which the sales user may still change the application's data. */
export const EDITABLE_STATUSES: readonly S[] = [S.DRAFT, S.INFO_REQUESTED];

export const canTransition = (from: S, to: S): boolean =>
  TRANSITIONS[from].includes(to);

export const assertTransition = (from: S, to: S): void => {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
};

export const isEditable = (status: S): boolean =>
  EDITABLE_STATUSES.includes(status);

export const isTerminal = (status: S): boolean =>
  TRANSITIONS[status].length === 0;

export const allowedTransitions = (from: S): readonly S[] => TRANSITIONS[from];
