import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { ApplicationStatus as S } from '../applications/enums/application-status.enum';
import { RiskStatus } from '../applications/enums/risk-status.enum';
import { MerchantApplication } from '../applications/merchant-application.entity';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditRecorder } from '../audit/audit-recorder';
import {
  RiskAssessment,
  RiskProviderClient,
  RiskProviderError,
} from './risk-provider';
import { RiskReviewProcessor } from './risk-review.processor';
import { RiskReviewService } from './risk-review.service';
import { RiskReviewJobData } from './risk-review.types';

const assessment: RiskAssessment = {
  score: 61,
  level: 'MEDIUM',
  flags: [],
  provider: 'simulated-kyb',
  reference: 'SIM-1',
};

const makeApp = (over: Partial<MerchantApplication> = {}) =>
  ({
    id: 'app-1',
    status: S.SUBMITTED,
    riskStatus: RiskStatus.PENDING,
    riskReviewRun: 1,
    businessType: 'restaurant',
    monthlyVolume: '25000.00',
    averageTicketSize: '42.50',
    currency: 'USD',
    // personal data that must never reach the provider or the queue
    ownerName: 'Pat Owner',
    ownerEmail: 'pat@example.com',
    ownerPhone: '+977 9876543210',
    ownerTaxId: '123-456-789',
    ...over,
  }) as MerchantApplication;

const makeJob = (
  over: { attemptsMade?: number; attempts?: number; run?: number } = {},
) =>
  ({
    id: 'risk-review-app-1-1',
    data: { applicationId: 'app-1', run: over.run ?? 1 },
    attemptsMade: over.attemptsMade ?? 0,
    opts: { attempts: over.attempts ?? 3 },
  }) as unknown as Job<RiskReviewJobData>;

describe('RiskReviewProcessor', () => {
  let repo: { findOneBy: jest.Mock };
  let provider: { assess: jest.Mock };
  let reviews: { markCompleted: jest.Mock; markFailed: jest.Mock };
  let audit: { record: jest.Mock };
  let processor: RiskReviewProcessor;

  const build = (env: Record<string, string> = {}) =>
    new RiskReviewProcessor(
      repo as unknown as Repository<MerchantApplication>,
      provider as unknown as RiskProviderClient,
      reviews as unknown as RiskReviewService,
      audit as unknown as AuditRecorder,
      {
        get: (k: string, d?: unknown) => env[k] ?? d,
      } as unknown as ConfigService,
    );

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation();
    repo = { findOneBy: jest.fn().mockResolvedValue(makeApp()) };
    provider = { assess: jest.fn().mockResolvedValue(assessment) };
    reviews = {
      markCompleted: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue(true),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    processor = build();
  });

  describe('happy path', () => {
    it('calls the provider, persists the result and reports completion', async () => {
      await expect(processor.process(makeJob())).resolves.toEqual({
        completed: true,
        score: 61,
      });
      expect(reviews.markCompleted).toHaveBeenCalledWith(
        'app-1',
        1,
        assessment,
      );
      expect(reviews.markFailed).not.toHaveBeenCalled();
    });

    it('sends the provider business facts only, never owner contact details or the tax id', async () => {
      await processor.process(makeJob());

      const sent = provider.assess.mock.calls[0][0];
      expect(sent).toEqual({
        applicationId: 'app-1',
        idempotencyKey: 'risk-review-app-1-1',
        businessType: 'restaurant',
        monthlyVolume: '25000.00',
        averageTicketSize: '42.50',
        currency: 'USD',
      });
      const json = JSON.stringify(sent);
      for (const pii of [
        'Pat Owner',
        'pat@example.com',
        '9876543210',
        '123-456-789',
      ]) {
        expect(json).not.toContain(pii);
      }
    });

    it.each([S.SUBMITTED, S.IN_REVIEW])(
      'processes an application that is %s',
      async (status) => {
        repo.findOneBy.mockResolvedValue(makeApp({ status }));
        await expect(processor.process(makeJob())).resolves.toMatchObject({
          completed: true,
        });
      },
    );

    it('announces the start once: on the first attempt only', async () => {
      await processor.process(makeJob({ attemptsMade: 0 }));
      await processor.process(makeJob({ attemptsMade: 1 }));
      await processor.process(makeJob({ attemptsMade: 2 }));

      const started = audit.record.mock.calls.filter(
        ([e]) => e.action === AuditAction.RISK_REVIEW_STARTED,
      );
      expect(started).toHaveLength(1);
      expect(started[0][0]).toMatchObject({
        actor: null,
        entityId: 'app-1',
        metadata: { run: 1 },
      });
    });
  });

  describe('idempotency: jobs that no longer need to do anything', () => {
    it.each([
      ['the application no longer exists', null, 'application-missing'],
      [
        'a newer submission or retry owns it (stale run)',
        makeApp({ riskReviewRun: 2 }),
        'superseded',
      ],
      [
        'the review already COMPLETED for this run',
        makeApp({ riskStatus: RiskStatus.COMPLETED }),
        'not-pending',
      ],
      [
        'the review already FAILED for this run',
        makeApp({ riskStatus: RiskStatus.FAILED }),
        'not-pending',
      ],
      [
        'the review was never requested',
        makeApp({ riskStatus: RiskStatus.NOT_STARTED }),
        'not-pending',
      ],
      [
        'the application went back to DRAFT',
        makeApp({ status: S.DRAFT }),
        'invalid-status',
      ],
      [
        'the application is INFO_REQUESTED',
        makeApp({ status: S.INFO_REQUESTED }),
        'invalid-status',
      ],
      [
        'the application is already APPROVED',
        makeApp({ status: S.APPROVED }),
        'invalid-status',
      ],
      [
        'the application is already REJECTED',
        makeApp({ status: S.REJECTED }),
        'invalid-status',
      ],
    ])('does nothing when %s', async (_name, app, reason) => {
      repo.findOneBy.mockResolvedValue(app);

      await expect(processor.process(makeJob())).resolves.toEqual({
        skipped: reason,
      });

      expect(provider.assess).not.toHaveBeenCalled();
      expect(reviews.markCompleted).not.toHaveBeenCalled();
      expect(reviews.markFailed).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('running the same job twice calls the provider once and writes once', async () => {
      await processor.process(makeJob());

      // after the first run the application is COMPLETED
      repo.findOneBy.mockResolvedValue(
        makeApp({ riskStatus: RiskStatus.COMPLETED }),
      );
      await processor.process(makeJob());

      expect(provider.assess).toHaveBeenCalledTimes(1);
      expect(reviews.markCompleted).toHaveBeenCalledTimes(1);
    });

    it('reports a stale result as skipped when the write finds the run superseded mid-flight', async () => {
      reviews.markCompleted.mockResolvedValue(false);
      await expect(processor.process(makeJob())).resolves.toEqual({
        skipped: 'superseded',
      });
      expect(reviews.markFailed).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    const transient = () =>
      new RiskProviderError('provider down', 'PROVIDER_UNAVAILABLE', true);

    it('rethrows a retryable failure so BullMQ retries, without marking FAILED', async () => {
      provider.assess.mockRejectedValue(transient());

      await expect(
        processor.process(makeJob({ attemptsMade: 0 })),
      ).rejects.toBeInstanceOf(RiskProviderError);
      expect(reviews.markFailed).not.toHaveBeenCalled();
    });

    it('also does not mark FAILED on the second of three attempts', async () => {
      provider.assess.mockRejectedValue(transient());
      await expect(
        processor.process(makeJob({ attemptsMade: 1 })),
      ).rejects.toThrow();
      expect(reviews.markFailed).not.toHaveBeenCalled();
    });

    it('marks FAILED on the final attempt, with the code and attempt count, and still rethrows', async () => {
      provider.assess.mockRejectedValue(transient());

      await expect(
        processor.process(makeJob({ attemptsMade: 2, attempts: 3 })),
      ).rejects.toBeInstanceOf(RiskProviderError);
      expect(reviews.markFailed).toHaveBeenCalledWith(
        'app-1',
        1,
        'PROVIDER_UNAVAILABLE',
        3,
      );
    });

    it('treats a single-attempt job as final immediately', async () => {
      provider.assess.mockRejectedValue(transient());
      await expect(
        processor.process(makeJob({ attemptsMade: 0, attempts: 1 })),
      ).rejects.toThrow();
      expect(reviews.markFailed).toHaveBeenCalledWith(
        'app-1',
        1,
        'PROVIDER_UNAVAILABLE',
        1,
      );
    });

    it('does not retry a permanent failure: marks FAILED at once and throws UnrecoverableError', async () => {
      provider.assess.mockRejectedValue(
        new RiskProviderError('input rejected', 'INPUT_REJECTED', false),
      );

      await expect(
        processor.process(makeJob({ attemptsMade: 0 })),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(reviews.markFailed).toHaveBeenCalledWith(
        'app-1',
        1,
        'INPUT_REJECTED',
        1,
      );
    });

    it('treats an unexpected error as retryable and records a generic code when final', async () => {
      provider.assess.mockRejectedValue(new Error('socket hang up'));

      await expect(
        processor.process(makeJob({ attemptsMade: 0 })),
      ).rejects.toThrow('socket hang up');
      expect(reviews.markFailed).not.toHaveBeenCalled();

      await expect(
        processor.process(makeJob({ attemptsMade: 2 })),
      ).rejects.toThrow('socket hang up');
      expect(reviews.markFailed).toHaveBeenCalledWith(
        'app-1',
        1,
        'UNEXPECTED_ERROR',
        3,
      );
    });

    it('a failure while persisting the result is retried like any other', async () => {
      reviews.markCompleted.mockRejectedValue(new Error('db connection lost'));
      await expect(
        processor.process(makeJob({ attemptsMade: 0 })),
      ).rejects.toThrow('db connection lost');
      expect(reviews.markFailed).not.toHaveBeenCalled();
    });
  });

  describe('worker lifecycle', () => {
    const fakeWorker = () => ({
      concurrency: 1,
      run: jest.fn().mockResolvedValue(undefined),
    });
    const attach = (
      p: RiskReviewProcessor,
      worker: ReturnType<typeof fakeWorker>,
    ) => {
      (p as unknown as { _worker: unknown })._worker = worker;
    };

    it('applies the configured concurrency and starts the worker', () => {
      const worker = fakeWorker();
      const p = build({ RISK_REVIEW_CONCURRENCY: '8' });
      attach(p, worker);

      p.onApplicationBootstrap();

      expect(worker.concurrency).toBe(8);
      expect(worker.run).toHaveBeenCalledTimes(1);
    });

    it('defaults concurrency to 5', () => {
      const worker = fakeWorker();
      const p = build();
      attach(p, worker);
      p.onApplicationBootstrap();
      expect(worker.concurrency).toBe(5);
    });

    it.each(['0', '-2', 'abc', '2.5'])(
      'falls back to 5 for concurrency %p',
      (bad) => {
        const worker = fakeWorker();
        const p = build({ RISK_REVIEW_CONCURRENCY: bad });
        attach(p, worker);
        p.onApplicationBootstrap();
        expect(worker.concurrency).toBe(5);
      },
    );

    it('does not start processing when RISK_REVIEW_WORKER_ENABLED=false', () => {
      const worker = fakeWorker();
      const p = build({ RISK_REVIEW_WORKER_ENABLED: 'false' });
      attach(p, worker);

      p.onApplicationBootstrap();

      expect(worker.run).not.toHaveBeenCalled();
    });
  });
});
