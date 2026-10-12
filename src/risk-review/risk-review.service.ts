import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { In, Repository } from 'typeorm';
import { ApplicationStatus } from '../applications/enums/application-status.enum';
import { RiskStatus } from '../applications/enums/risk-status.enum';
import { MerchantApplication } from '../applications/merchant-application.entity';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditRecorder } from '../audit/audit-recorder';
import { RISK_REVIEW_JOB, RISK_REVIEW_QUEUE } from '../queue/queue.constants';
import { RiskAssessment } from './risk-provider';
import { RiskReviewJobData, riskReviewJobId } from './risk-review.types';

const ENTITY_TYPE = 'MerchantApplication';

/** Statuses in which a risk review is still meaningful. */
export const RISK_REVIEWABLE_STATUSES = [
  ApplicationStatus.SUBMITTED,
  ApplicationStatus.IN_REVIEW,
] as const;

/**
 * Starting a review and persisting its outcome. Every write is a
 * compare-and-set on (id, riskReviewRun, riskStatus = PENDING): a result for a
 * superseded run, or one that was already applied, changes nothing.
 */
@Injectable()
export class RiskReviewService {
  private readonly logger = new Logger(RiskReviewService.name);

  constructor(
    @InjectQueue(RISK_REVIEW_QUEUE)
    private readonly queue: Queue<RiskReviewJobData>,
    @InjectRepository(MerchantApplication)
    private readonly repo: Repository<MerchantApplication>,
    private readonly audit: AuditRecorder,
  ) {}

  /**
   * Enqueues the job for one review request. The caller has ALREADY committed
   * `riskStatus = PENDING` and the new `riskReviewRun`.
   *
   * Trade-off (the transactional-outbox problem): Postgres and Redis cannot
   * share a transaction, so there is a window between "committed" and
   * "enqueued". We commit first and enqueue second, because the opposite order
   * can leave a job for state that never existed. If the enqueue fails we
   * compensate by marking the review FAILED, which an admin can re-trigger via
   * POST /applications/:id/risk-review/retry. Nothing is ever silently stuck in
   * PENDING because of a failed enqueue. A crash between the commit and this
   * call can still leave a PENDING review without a job; a transactional
   * outbox table + relay, or a reconciler that re-enqueues old PENDING rows,
   * would close that last gap and is the production answer.
   *
   * Re-enqueueing the same (application, run) is harmless: BullMQ ignores a
   * second `add` with an existing job id.
   *
   * @returns true when the job is queued, false when it could not be queued
   */
  async enqueue(applicationId: string, run: number): Promise<boolean> {
    try {
      await this.queue.add(
        RISK_REVIEW_JOB,
        { applicationId, run },
        { jobId: riskReviewJobId(applicationId, run) },
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Could not enqueue risk review application=${applicationId} run=${run}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      await this.markFailed(applicationId, run, 'ENQUEUE_FAILED', 0);
      return false;
    }
  }

  /** Stores the provider's answer. False when the run was superseded or already applied. */
  async markCompleted(
    applicationId: string,
    run: number,
    assessment: RiskAssessment,
  ): Promise<boolean> {
    const result = await this.repo.update(
      {
        id: applicationId,
        riskReviewRun: run,
        riskStatus: RiskStatus.PENDING,
        status: In([...RISK_REVIEWABLE_STATUSES]),
      },
      {
        riskStatus: RiskStatus.COMPLETED,
        riskScore: assessment.score,
        riskResult: { ...assessment },
      },
    );
    if (!result.affected) {
      return false;
    }
    await this.audit.record({
      action: AuditAction.RISK_REVIEW_COMPLETED,
      actor: null,
      entityType: ENTITY_TYPE,
      entityId: applicationId,
      metadata: { run, score: assessment.score, level: assessment.level },
    });
    return true;
  }

  /**
   * Records a final failure. Only a code and attempt count are stored, never
   * the provider's raw error text.
   */
  async markFailed(
    applicationId: string,
    run: number,
    code: string,
    attempts: number,
  ): Promise<boolean> {
    const result = await this.repo.update(
      {
        id: applicationId,
        riskReviewRun: run,
        riskStatus: RiskStatus.PENDING,
      },
      {
        riskStatus: RiskStatus.FAILED,
        riskScore: null,
        riskResult: { failure: { code, attempts } },
      },
    );
    if (!result.affected) {
      return false;
    }
    await this.audit.record({
      action: AuditAction.RISK_REVIEW_FAILED,
      actor: null,
      entityType: ENTITY_TYPE,
      entityId: applicationId,
      metadata: { run, code, attempts },
    });
    return true;
  }
}
