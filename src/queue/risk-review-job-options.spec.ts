import { buildRiskReviewJobOptions } from './risk-review-job-options';

const cfg = (values: Record<string, unknown>) => ({
  get: (key: string) => values[key],
});

describe('buildRiskReviewJobOptions', () => {
  it('defaults to 3 attempts with 1s exponential backoff', () => {
    expect(buildRiskReviewJobOptions(cfg({}))).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  });

  it('reads attempts and backoff from the environment (strings, as env gives them)', () => {
    const opts = buildRiskReviewJobOptions(
      cfg({ RISK_REVIEW_ATTEMPTS: '5', RISK_REVIEW_BACKOFF_MS: '50' }),
    );
    expect(opts.attempts).toBe(5);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 50 });
  });

  it.each(['0', '-1', 'abc', '1.5', ''])(
    'falls back to defaults for %p',
    (bad) => {
      const opts = buildRiskReviewJobOptions(
        cfg({ RISK_REVIEW_ATTEMPTS: bad, RISK_REVIEW_BACKOFF_MS: bad }),
      );
      expect(opts.attempts).toBe(3);
      expect(opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
    },
  );

  it('keeps failed jobs for inspection but drops completed ones', () => {
    const opts = buildRiskReviewJobOptions(cfg({}));
    expect(opts.removeOnFail).toBe(false);
    expect(opts.removeOnComplete).toBe(true);
  });
});
