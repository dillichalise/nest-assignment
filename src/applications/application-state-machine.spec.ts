import {
  allowedTransitions,
  assertTransition,
  canTransition,
  isEditable,
  isTerminal,
} from './application-state-machine';
import { InvalidStateTransitionError } from './application.errors';
import { ApplicationStatus as S } from './enums/application-status.enum';

const ALL = Object.values(S);

// Independent source of truth for the test: every VALID pair, spelled out.
const VALID: ReadonlyArray<[S, S]> = [
  [S.DRAFT, S.SUBMITTED],
  [S.SUBMITTED, S.IN_REVIEW],
  [S.IN_REVIEW, S.APPROVED],
  [S.IN_REVIEW, S.REJECTED],
  [S.IN_REVIEW, S.INFO_REQUESTED],
  [S.INFO_REQUESTED, S.SUBMITTED],
];
const isValid = (from: S, to: S) =>
  VALID.some(([f, t]) => f === from && t === to);

const ALL_PAIRS = ALL.flatMap((from) => ALL.map((to) => [from, to] as const));

describe('application state machine', () => {
  it('covers every status pair (6 x 6)', () => {
    expect(ALL_PAIRS).toHaveLength(36);
  });

  describe.each(ALL_PAIRS)('%s -> %s', (from, to) => {
    const expected = isValid(from, to);

    it(`canTransition is ${expected}`, () => {
      expect(canTransition(from, to)).toBe(expected);
    });

    it(
      expected ? 'assertTransition passes' : 'assertTransition throws 409',
      () => {
        if (expected) {
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertTransition(from, to)).toThrow(
            InvalidStateTransitionError,
          );
        }
      },
    );
  });

  it('never allows a status to transition to itself', () => {
    ALL.forEach((s) => expect(canTransition(s, s)).toBe(false));
  });

  it('treats APPROVED and REJECTED as terminal', () => {
    expect(isTerminal(S.APPROVED)).toBe(true);
    expect(isTerminal(S.REJECTED)).toBe(true);
    expect(allowedTransitions(S.APPROVED)).toEqual([]);
    expect(isTerminal(S.DRAFT)).toBe(false);
  });

  it('only DRAFT and INFO_REQUESTED are editable', () => {
    const editable = ALL.filter(isEditable);
    expect(editable.sort()).toEqual([S.DRAFT, S.INFO_REQUESTED].sort());
  });

  it('invalid transition error is a 409 carrying from/to', () => {
    try {
      assertTransition(S.APPROVED, S.DRAFT);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as InvalidStateTransitionError;
      expect(err.status).toBe(409);
      expect(err.code).toBe('INVALID_STATE_TRANSITION');
      expect(err.details).toEqual({ from: S.APPROVED, to: S.DRAFT });
    }
  });
});
