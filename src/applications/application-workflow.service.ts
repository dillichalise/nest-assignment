import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user.interface';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditRecorder } from '../audit/audit-recorder';
import { Role } from '../common/enums/role.enum';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../common/errors/domain.error';
import { PolicyService } from '../policies/policy.service';
import {
  RISK_REVIEWABLE_STATUSES,
  RiskReviewService,
} from '../risk-review/risk-review.service';
import { UsersService } from '../users/users.service';
import { findIncompleteFields } from './application-completeness';
import { assertTransition } from './application-state-machine';
import { applyTransition } from './application-transition';
import {
  RiskReviewNotCompleteError,
  RiskReviewNotRetryableError,
  RiskReviewUnavailableError,
} from './application.errors';
import { ReviewDecision } from './dto/record-decision.dto';
import { ApplicationStatus } from './enums/application-status.enum';
import { RiskStatus } from './enums/risk-status.enum';
import { MerchantApplication } from './merchant-application.entity';

const ENTITY_TYPE = 'MerchantApplication';

/**
 * Lifecycle actions after creation: submit, assign, decide. CRUD lives in
 * ApplicationsService. Every status change goes through `applyTransition`
 * (state-machine check + compare-and-set), so invalid or racing requests end
 * in a 409 and never corrupt state.
 */
@Injectable()
export class ApplicationWorkflowService {
  constructor(
    @InjectRepository(MerchantApplication)
    private readonly repo: Repository<MerchantApplication>,
    private readonly policy: PolicyService,
    private readonly users: UsersService,
    private readonly audit: AuditRecorder,
    private readonly riskReviews: RiskReviewService,
  ) {}

  /** SALES (owner) or ADMIN: DRAFT | INFO_REQUESTED -> SUBMITTED. */
  async submit(user: AuthUser, id: string): Promise<MerchantApplication> {
    const application = await this.loadOrNotFound(id);

    // Same rule as editing: owner or ADMIN. Others get the usual 404.
    this.policy.assertCanEdit(user, application);
    assertTransition(application.status, ApplicationStatus.SUBMITTED);

    const missingFields = findIncompleteFields(application);
    if (missingFields.length > 0) {
      throw new UnprocessableError('Application is incomplete', {
        missingFields,
      });
    }

    await applyTransition(
      this.repo,
      id,
      application.status,
      ApplicationStatus.SUBMITTED,
      {
        submittedAt: new Date(),
        // Every submission is reviewed from scratch: clear the previous
        // round's result, mark the review PENDING and bump the run counter.
        // All of it is part of the SAME single UPDATE as the status change, so
        // the application is never SUBMITTED without a pending review.
        riskStatus: RiskStatus.PENDING,
        riskScore: null,
        riskResult: null,
        riskReviewRun: () => '"riskReviewRun" + 1',
      },
    );

    await this.audit.record({
      action: AuditAction.APPLICATION_SUBMITTED,
      actor: user,
      entityType: ENTITY_TYPE,
      entityId: id,
      metadata: { from: application.status, to: ApplicationStatus.SUBMITTED },
    });

    // Queue the background review AFTER the commit. If queueing fails the
    // review is marked FAILED (retryable by an admin) and the submission itself
    // still stands; see RiskReviewService.enqueue for the trade-off.
    const submitted = await this.repo.findOneByOrFail({ id });
    await this.riskReviews.enqueue(id, submitted.riskReviewRun);

    return this.repo.findOneByOrFail({ id });
  }

  /**
   * ADMIN only. Re-triggers a FAILED risk review, for an application that is
   * still SUBMITTED or IN_REVIEW. Returns at once with riskStatus PENDING; the
   * worker does the rest.
   */
  async retryRiskReview(
    user: AuthUser,
    id: string,
  ): Promise<MerchantApplication> {
    this.policy.assertCanManageRiskReview(user);

    const application = await this.loadOrNotFound(id);
    if (
      application.riskStatus !== RiskStatus.FAILED ||
      !RISK_REVIEWABLE_STATUSES.includes(application.status as never)
    ) {
      throw new RiskReviewNotRetryableError(
        application.riskStatus,
        application.status,
      );
    }

    // Compare-and-set: of two concurrent retries only one starts a new run.
    const result = await this.repo.update(
      {
        id,
        riskStatus: RiskStatus.FAILED,
        status: In([...RISK_REVIEWABLE_STATUSES]),
      },
      {
        riskStatus: RiskStatus.PENDING,
        riskScore: null,
        riskResult: null,
        riskReviewRun: () => '"riskReviewRun" + 1',
      },
    );
    if (!result.affected) {
      throw new ConflictError(
        'Risk review state changed concurrently; reload and retry',
      );
    }

    const restarted = await this.repo.findOneByOrFail({ id });
    await this.audit.record({
      action: AuditAction.RISK_REVIEW_RETRY_REQUESTED,
      actor: user,
      entityType: ENTITY_TYPE,
      entityId: id,
      metadata: { run: restarted.riskReviewRun },
    });

    if (!(await this.riskReviews.enqueue(id, restarted.riskReviewRun))) {
      // enqueue() already put the review back to FAILED.
      throw new RiskReviewUnavailableError();
    }
    return this.repo.findOneByOrFail({ id });
  }

  /**
   * ADMIN only. SUBMITTED -> IN_REVIEW with the chosen reviewer.
   *
   * Re-assignment rule: while IN_REVIEW the reviewer MAY be changed (a reviewer
   * can be unavailable); the status stays IN_REVIEW. In every other status it
   * is a 409. Assigning the reviewer who already holds it is a no-op.
   */
  async assign(
    user: AuthUser,
    id: string,
    reviewerId: string,
  ): Promise<MerchantApplication> {
    this.policy.assertCanAssignReviewer(user);

    const application = await this.loadOrNotFound(id);
    await this.assertAssignableReviewer(reviewerId);

    if (application.status === ApplicationStatus.IN_REVIEW) {
      if (application.assignedReviewerId === reviewerId) {
        return application;
      }
      const result = await this.repo.update(
        { id, status: ApplicationStatus.IN_REVIEW },
        { assignedReviewerId: reviewerId },
      );
      if (!result.affected) {
        throw new ConflictError(
          'Application status changed concurrently; reload and retry',
        );
      }
    } else {
      // Throws a 409 unless the application is SUBMITTED.
      await applyTransition(
        this.repo,
        id,
        application.status,
        ApplicationStatus.IN_REVIEW,
        { assignedReviewerId: reviewerId },
      );
    }

    await this.audit.record({
      action: AuditAction.REVIEWER_ASSIGNED,
      actor: user,
      entityType: ENTITY_TYPE,
      entityId: id,
      metadata: {
        reviewerId,
        previousReviewerId: application.assignedReviewerId,
        reassigned: application.status === ApplicationStatus.IN_REVIEW,
      },
    });
    return this.repo.findOneByOrFail({ id });
  }

  /**
   * Only the ASSIGNED reviewer may decide (no ADMIN override: an admin who
   * could also approve would defeat the separation between operating the
   * queue and making risk calls).
   *
   * Rule: a decision requires riskStatus = COMPLETED, so a reviewer never
   * decides on a pending or failed risk check.
   */
  async decide(
    user: AuthUser,
    id: string,
    decision: ReviewDecision,
    reason?: string,
  ): Promise<MerchantApplication> {
    const application = await this.loadOrNotFound(id);

    // 404 if the reviewer cannot see it (not assigned), 403 if visible but not allowed.
    this.policy.assertCanDecide(user, application);

    const target = ApplicationStatus[decision];
    assertTransition(application.status, target);

    if (application.riskStatus !== RiskStatus.COMPLETED) {
      throw new RiskReviewNotCompleteError(application.riskStatus);
    }

    await applyTransition(this.repo, id, application.status, target, {
      decisionReason: reason ?? null,
      decidedAt: new Date(),
    });

    await this.audit.record({
      action: AuditAction.DECISION_RECORDED,
      actor: user,
      entityType: ENTITY_TYPE,
      entityId: id,
      metadata: { decision, reason: reason ?? null },
    });
    return this.repo.findOneByOrFail({ id });
  }

  private async assertAssignableReviewer(reviewerId: string): Promise<void> {
    const reviewer = await this.users.findById(reviewerId);
    // One message for missing / inactive / wrong role.
    if (!reviewer || !reviewer.isActive || reviewer.role !== Role.REVIEWER) {
      throw new UnprocessableError(
        'reviewerId must refer to an active user with the REVIEWER role',
      );
    }
  }

  private async loadOrNotFound(id: string): Promise<MerchantApplication> {
    const application = await this.repo.findOneBy({ id });
    if (!application) {
      throw new NotFoundError('Application not found');
    }
    return application;
  }
}
