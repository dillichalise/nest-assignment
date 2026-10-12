import { ConfigService } from '@nestjs/config';
import { DefaultJobOptions } from 'bullmq';

const positiveInt = (raw: unknown, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * Retry policy for risk-review jobs: exponential backoff (delay, 2x, 4x, ...).
 * Failed jobs are kept (removeOnFail: false) so they can be inspected; completed
 * ones are dropped because the result lives in Postgres.
 */
export const buildRiskReviewJobOptions = (
  config: Pick<ConfigService, 'get'>,
): DefaultJobOptions => ({
  attempts: positiveInt(config.get('RISK_REVIEW_ATTEMPTS'), 3),
  backoff: {
    type: 'exponential',
    delay: positiveInt(config.get('RISK_REVIEW_BACKOFF_MS'), 1000),
  },
  removeOnComplete: true,
  removeOnFail: false,
});
