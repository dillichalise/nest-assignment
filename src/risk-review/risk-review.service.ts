import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DataSource, In } from 'typeorm';
import { ApplicationStatus } from '../applications/enums/application-status.enum';
import { RiskStatus } from '../applications/enums/risk-status.enum';
import { MerchantApplication } from '../applications/merchant-application.entity';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditEntityType } from '../audit/audit-entity-type';
import { AuditRecorder } from '../audit/audit-recorder';
import { RISK_REVIEW_JOB, RISK_REVIEW_QUEUE } from '../queue/queue.constants';
import { RiskAssessment } from './risk-provider';
import { RiskReviewJobData, riskReviewJobId } from './risk-review.types';

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
    private readonly dataSource: DataSource,
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

  /**
   * Stores the provider's answer, with its audit record in the same
   * transaction. False when the run was superseded or already applied (then
   * nothing is written and nothing is audited).
   *
   * `correlationId` is the BullMQ job id when called from the worker.
   */
  async markCompleted(
    applicationId: string,
    run: number,
    assessment: RiskAssessment,
    correlationId?: string,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager.getRepository(MerchantApplication).update(
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
      await this.audit.record(
        {
          action: AuditAction.RISK_REVIEW_COMPLETED,
          actor: null,
          entityType: AuditEntityType.APPLICATION,
          entityId: applicationId,
          metadata: { run, score: assessment.score, level: assessment.level },
          correlationId,
        },
        manager,
      );
      return true;
    });
  }

  /**
   * Records a final failure, with its audit record in the same transaction.
   * Only a code and attempt count are stored, never the provider's raw error
   * text.
   */
  async markFailed(
    applicationId: string,
    run: number,
    code: string,
    attempts: number,
    correlationId?: string,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager.getRepository(MerchantApplication).update(
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
      await this.audit.record(
        {
          action: AuditAction.RISK_REVIEW_FAILED,
          actor: null,
          entityType: AuditEntityType.APPLICATION,
          entityId: applicationId,
          metadata: { run, code, attempts },
          correlationId,
        },
        manager,
      );
      return true;
    });
  }
}
