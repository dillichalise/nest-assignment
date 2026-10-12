/**
 * Job payload. Ids only, on purpose: the queue lives in Redis, so no business
 * data (let alone PII) is copied there. The worker reads the application from
 * Postgres. `run` ties the job to one specific risk-review request.
 */
export interface RiskReviewJobData {
  applicationId: string;
  run: number;
}

/**
 * Deterministic: the same application + run always maps to the same id, and
 * BullMQ ignores an `add` whose id already exists. Dashes, not the colons of
 * the pack text, because BullMQ restricts ':' in custom ids.
 */
export const riskReviewJobId = (applicationId: string, run: number): string =>
  `risk-review-${applicationId}-${run}`;

export type RiskReviewSkipReason =
  'application-missing' | 'superseded' | 'not-pending' | 'invalid-status';

export type RiskReviewOutcome =
  { completed: true; score: number } | { skipped: RiskReviewSkipReason };
