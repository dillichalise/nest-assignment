import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { RiskStatus } from '../applications/enums/risk-status.enum';
import { MerchantApplication } from '../applications/merchant-application.entity';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditRecorder } from '../audit/audit-recorder';
import { RISK_REVIEW_QUEUE } from '../queue/queue.constants';
import { RiskProviderClient, RiskProviderError } from './risk-provider';
import {
  RISK_REVIEWABLE_STATUSES,
  RiskReviewService,
} from './risk-review.service';
import {
  RiskReviewJobData,
  RiskReviewOutcome,
  RiskReviewSkipReason,
  riskReviewJobId,
} from './risk-review.types';

const DEFAULT_CONCURRENCY = 5;

/**
 * Runs risk reviews in the background.
 *
 * Idempotent by construction: a job does nothing unless the application is
 * still waiting for exactly this run's result (see `skipReason`), and the
 * result is written with a compare-and-set. Running the same job twice,
 * running a stale job, or running a job whose application moved on all leave
 * the data untouched.
 *
 * `autorun: false` + `onApplicationBootstrap` lets the worker be switched off
 * (RISK_REVIEW_WORKER_ENABLED=false) and its concurrency come from the
 * environment, which decorator options cannot do because they are evaluated
 * before .env is loaded.
 */
@Processor(RISK_REVIEW_QUEUE, { autorun: false })
export class RiskReviewProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(RiskReviewProcessor.name);

  constructor(
    @InjectRepository(MerchantApplication)
    private readonly repo: Repository<MerchantApplication>,
    private readonly provider: RiskProviderClient,
    private readonly reviews: RiskReviewService,
    private readonly audit: AuditRecorder,
    private readonly config: ConfigService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    const concurrency = Number(
      this.config.get('RISK_REVIEW_CONCURRENCY', DEFAULT_CONCURRENCY),
    );
    this.worker.concurrency =
      Number.isInteger(concurrency) && concurrency > 0
        ? concurrency
        : DEFAULT_CONCURRENCY;

    if (this.config.get('RISK_REVIEW_WORKER_ENABLED', 'true') === 'false') {
      this.logger.log('Risk-review worker is disabled');
      return;
    }
    void this.worker.run().catch((error: Error) => {
      this.logger.error(`Risk-review worker stopped: ${error.message}`);
    });
  }

  async process(job: Job<RiskReviewJobData>): Promise<RiskReviewOutcome> {
    const { applicationId, run } = job.data;

    const application = await this.repo.findOneBy({ id: applicationId });
    const skip = this.skipReason(application, run);
    if (skip || !application) {
      this.logger.log(
        `Skipping risk review application=${applicationId} run=${run}: ${skip}`,
      );
      return { skipped: skip ?? 'application-missing' };
    }

    // Retries re-enter process(); announce the start once.
    if (job.attemptsMade === 0) {
      await this.audit.record({
        action: AuditAction.RISK_REVIEW_STARTED,
        actor: null,
        entityType: 'MerchantApplication',
        entityId: applicationId,
        metadata: { run },
      });
    }

    try {
      const assessment = await this.provider.assess({
        applicationId,
        idempotencyKey: job.id ?? riskReviewJobId(applicationId, run),
        businessType: application.businessType,
        monthlyVolume: application.monthlyVolume,
        averageTicketSize: application.averageTicketSize,
        currency: application.currency,
      });

      const applied = await this.reviews.markCompleted(
        applicationId,
        run,
        assessment,
      );
      return applied
        ? { completed: true, score: assessment.score }
        : { skipped: 'superseded' };
    } catch (error) {
      throw await this.handleFailure(job, error);
    }
  }

  /**
   * Decides whether this failure is the last one. If so, the review is marked
   * FAILED here, in the same code path that still has the job, instead of in
   * a 'failed' event handler where a crash could leave it PENDING forever.
   * Returns the error BullMQ should record: unrecoverable for permanent
   * failures (no retries), the original for retryable ones.
   */
  private async handleFailure(job: Job<RiskReviewJobData>, error: unknown) {
    const { applicationId, run } = job.data;
    const retryable = !(error instanceof RiskProviderError) || error.retryable;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const isFinal = !retryable || attempt >= maxAttempts;

    const message = error instanceof Error ? error.message : 'unknown error';
    this.logger.warn(
      `Risk review attempt ${attempt}/${maxAttempts} failed application=${applicationId} run=${run}${
        isFinal ? ' (final)' : ', will retry'
      }: ${message}`,
    );

    if (isFinal) {
      const code =
        error instanceof RiskProviderError ? error.code : 'UNEXPECTED_ERROR';
      await this.reviews.markFailed(applicationId, run, code, attempt);
    }
    return !retryable ? new UnrecoverableError(message) : error;
  }

  private skipReason(
    application: MerchantApplication | null,
    run: number,
  ): RiskReviewSkipReason | null {
    if (!application) return 'application-missing';
    // A newer submission or retry owns the application now.
    if (application.riskReviewRun !== run) return 'superseded';
    // Already completed/failed for this run, or never requested.
    if (application.riskStatus !== RiskStatus.PENDING) return 'not-pending';
    if (!RISK_REVIEWABLE_STATUSES.includes(application.status as never)) {
      return 'invalid-status';
    }
    return null;
  }

  @OnWorkerEvent('error')
  onWorkerError(error: Error): void {
    this.logger.error(`Risk-review worker error: ${error.message}`);
  }
}
