import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditRecorder } from '../audit/audit-recorder';
import { AuthUser } from '../auth/auth-user.interface';
import { Role } from '../common/enums/role.enum';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../common/errors/domain.error';
import { PolicyService } from '../policies/policy.service';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { ApplicationWorkflowService } from './application-workflow.service';
import {
  InvalidStateTransitionError,
  RiskReviewNotCompleteError,
} from './application.errors';
import { ReviewDecision } from './dto/record-decision.dto';
import { ApplicationStatus as S } from './enums/application-status.enum';
import { RiskStatus } from './enums/risk-status.enum';
import { MerchantApplication } from './merchant-application.entity';

const user = (id: string, role: Role): AuthUser => ({
  id,
  email: `${id}@example.com`,
  role,
});
const salesA = user('salesA', Role.SALES);
const salesB = user('salesB', Role.SALES);
const admin = user('admin', Role.ADMIN);
const rev1 = user('rev1', Role.REVIEWER);
const rev2 = user('rev2', Role.REVIEWER);

const makeApp = (over: Partial<MerchantApplication> = {}) =>
  ({
    id: 'app1',
    createdById: 'salesA',
    assignedReviewerId: null,
    status: S.DRAFT,
    riskStatus: RiskStatus.NOT_STARTED,
    businessName: 'Moka Cafe',
    legalBusinessName: 'Moka Cafe Pvt Ltd',
    businessType: 'cafe',
    ownerName: 'Cafe Owner',
    ownerEmail: 'cafe_owner@example.com',
    ownerPhone: '+977 9876543210',
    ownerTaxId: '123-456-789',
    currency: 'USD',
    monthlyVolume: '25000.00',
    averageTicketSize: '42.50',
    ...over,
  }) as MerchantApplication;

describe('ApplicationWorkflowService', () => {
  let repo: {
    findOneBy: jest.Mock;
    findOneByOrFail: jest.Mock;
    update: jest.Mock;
  };
  let users: { findById: jest.Mock };
  let audit: { record: jest.Mock };
  let service: ApplicationWorkflowService;

  const reviewerUser = (over: Partial<User> = {}) =>
    ({ id: 'rev1', role: Role.REVIEWER, isActive: true, ...over }) as User;

  beforeEach(() => {
    repo = {
      findOneBy: jest.fn(),
      findOneByOrFail: jest.fn().mockResolvedValue(makeApp()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    users = { findById: jest.fn().mockResolvedValue(reviewerUser()) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ApplicationWorkflowService(
      repo as unknown as Repository<MerchantApplication>,
      new PolicyService(),
      users as unknown as UsersService,
      audit as unknown as AuditRecorder,
    );
  });

  describe('submit', () => {
    it.each([S.DRAFT, S.INFO_REQUESTED])(
      'moves %s to SUBMITTED, resets risk, records audit',
      async (from) => {
        repo.findOneBy.mockResolvedValue(makeApp({ status: from }));

        await service.submit(salesA, 'app1');

        const [where, patch] = repo.update.mock.calls[0];
        expect(where).toEqual({ id: 'app1', status: from });
        expect(patch).toMatchObject({
          status: S.SUBMITTED,
          riskStatus: RiskStatus.NOT_STARTED,
          riskScore: null,
          riskResult: null,
        });
        expect(patch.submittedAt).toBeInstanceOf(Date);
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.APPLICATION_SUBMITTED,
            entityId: 'app1',
            actor: salesA,
          }),
        );
      },
    );

    it('lets ADMIN submit someone else’s application', async () => {
      repo.findOneBy.mockResolvedValue(makeApp());
      await expect(service.submit(admin, 'app1')).resolves.toBeDefined();
    });

    it('hides another SALES user’s application with a 404 and changes nothing', async () => {
      repo.findOneBy.mockResolvedValue(makeApp());
      await expect(service.submit(salesB, 'app1')).rejects.toThrow(
        NotFoundError,
      );
      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each([S.SUBMITTED, S.IN_REVIEW, S.APPROVED, S.REJECTED])(
      'rejects submitting from %s (covers double submit)',
      async (status) => {
        repo.findOneBy.mockResolvedValue(makeApp({ status }));
        await expect(service.submit(salesA, 'app1')).rejects.toThrow(
          InvalidStateTransitionError,
        );
        expect(repo.update).not.toHaveBeenCalled();
      },
    );

    it('rejects an incomplete application with a 422 listing the fields', async () => {
      repo.findOneBy.mockResolvedValue(makeApp({ businessName: '' }));
      const err = await service.submit(salesA, 'app1').catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableError);
      expect(err.details).toEqual({ missingFields: ['businessName'] });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('returns 409 if a concurrent request moved the status first', async () => {
      repo.findOneBy.mockResolvedValue(makeApp());
      repo.update.mockResolvedValue({ affected: 0 });
      await expect(service.submit(salesA, 'app1')).rejects.toThrow(
        ConflictError,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('assign', () => {
    it('moves SUBMITTED to IN_REVIEW with the reviewer and records audit', async () => {
      repo.findOneBy.mockResolvedValue(makeApp({ status: S.SUBMITTED }));

      await service.assign(admin, 'app1', 'rev1');

      const [where, patch] = repo.update.mock.calls[0];
      expect(where).toEqual({ id: 'app1', status: S.SUBMITTED });
      expect(patch).toEqual({
        assignedReviewerId: 'rev1',
        status: S.IN_REVIEW,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.REVIEWER_ASSIGNED,
          metadata: {
            reviewerId: 'rev1',
            previousReviewerId: null,
            reassigned: false,
          },
        }),
      );
    });

    it('only ADMIN may assign (defense in depth behind the role guard)', async () => {
      for (const who of [salesA, rev1]) {
        await expect(service.assign(who, 'app1', 'rev1')).rejects.toThrow(
          ForbiddenException,
        );
      }
      expect(repo.findOneBy).not.toHaveBeenCalled();
    });

    it.each([
      ['does not exist', null],
      ['is inactive', reviewerUser({ isActive: false })],
      ['is not a REVIEWER', reviewerUser({ role: Role.SALES })],
      ['is an ADMIN', reviewerUser({ role: Role.ADMIN })],
    ])('rejects a target that %s with 422', async (_n, found) => {
      repo.findOneBy.mockResolvedValue(makeApp({ status: S.SUBMITTED }));
      users.findById.mockResolvedValue(found);
      await expect(service.assign(admin, 'app1', 'x')).rejects.toThrow(
        UnprocessableError,
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('allows re-assignment while IN_REVIEW and keeps the status', async () => {
      repo.findOneBy.mockResolvedValue(
        makeApp({ status: S.IN_REVIEW, assignedReviewerId: 'rev1' }),
      );
      users.findById.mockResolvedValue(reviewerUser({ id: 'rev2' }));

      await service.assign(admin, 'app1', 'rev2');

      const [where, patch] = repo.update.mock.calls[0];
      expect(where).toEqual({ id: 'app1', status: S.IN_REVIEW });
      expect(patch).toEqual({ assignedReviewerId: 'rev2' });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            reviewerId: 'rev2',
            previousReviewerId: 'rev1',
            reassigned: true,
          },
        }),
      );
    });

    it('is a no-op (no write, no audit) when the same reviewer is assigned again', async () => {
      repo.findOneBy.mockResolvedValue(
        makeApp({ status: S.IN_REVIEW, assignedReviewerId: 'rev1' }),
      );
      await service.assign(admin, 'app1', 'rev1');
      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each([S.DRAFT, S.INFO_REQUESTED, S.APPROVED, S.REJECTED])(
      'rejects assignment from %s with a 409',
      async (status) => {
        repo.findOneBy.mockResolvedValue(makeApp({ status }));
        await expect(service.assign(admin, 'app1', 'rev1')).rejects.toThrow(
          InvalidStateTransitionError,
        );
      },
    );

    it('returns 404 for a missing application', async () => {
      repo.findOneBy.mockResolvedValue(null);
      await expect(service.assign(admin, 'nope', 'rev1')).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('decide', () => {
    const inReview = (over: Partial<MerchantApplication> = {}) =>
      makeApp({
        status: S.IN_REVIEW,
        assignedReviewerId: 'rev1',
        riskStatus: RiskStatus.COMPLETED,
        ...over,
      });

    it.each([
      [ReviewDecision.APPROVED, undefined, S.APPROVED],
      [ReviewDecision.REJECTED, 'Failed KYB', S.REJECTED],
      [ReviewDecision.INFO_REQUESTED, 'Need licence', S.INFO_REQUESTED],
    ])('assigned reviewer records %s', async (decision, reason, expected) => {
      repo.findOneBy.mockResolvedValue(inReview());

      await service.decide(rev1, 'app1', decision, reason);

      const [where, patch] = repo.update.mock.calls[0];
      expect(where).toEqual({ id: 'app1', status: S.IN_REVIEW });
      expect(patch.status).toBe(expected);
      expect(patch.decisionReason).toBe(reason ?? null);
      expect(patch.decidedAt).toBeInstanceOf(Date);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DECISION_RECORDED,
          metadata: { decision, reason: reason ?? null },
        }),
      );
    });

    it('hides the application from a reviewer who is not assigned (404)', async () => {
      repo.findOneBy.mockResolvedValue(inReview());
      await expect(
        service.decide(rev2, 'app1', ReviewDecision.APPROVED),
      ).rejects.toThrow(NotFoundError);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('gives ADMIN and the owner no override (403) and hides it from other SALES users (404)', async () => {
      repo.findOneBy.mockResolvedValue(inReview());
      await expect(
        service.decide(admin, 'app1', ReviewDecision.APPROVED),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.decide(salesB, 'app1', ReviewDecision.APPROVED),
      ).rejects.toThrow(NotFoundError);
      // the owner can see it, so the denial is a 403 rather than a 404
      await expect(
        service.decide(salesA, 'app1', ReviewDecision.APPROVED),
      ).rejects.toThrow(ForbiddenException);
    });

    it.each([S.APPROVED, S.REJECTED, S.INFO_REQUESTED, S.SUBMITTED])(
      'rejects a decision when the application is %s (covers double decision)',
      async (status) => {
        repo.findOneBy.mockResolvedValue(inReview({ status }));
        await expect(
          service.decide(rev1, 'app1', ReviewDecision.APPROVED),
        ).rejects.toThrow(InvalidStateTransitionError);
        expect(repo.update).not.toHaveBeenCalled();
      },
    );

    it.each([RiskStatus.NOT_STARTED, RiskStatus.PENDING, RiskStatus.FAILED])(
      'requires a completed risk review (rejects %s)',
      async (riskStatus) => {
        repo.findOneBy.mockResolvedValue(inReview({ riskStatus }));
        const err = await service
          .decide(rev1, 'app1', ReviewDecision.APPROVED)
          .catch((e) => e);
        expect(err).toBeInstanceOf(RiskReviewNotCompleteError);
        expect(err.status).toBe(409);
        expect(repo.update).not.toHaveBeenCalled();
      },
    );

    it('only one of two racing decisions wins (409 for the loser)', async () => {
      repo.findOneBy.mockResolvedValue(inReview());
      repo.update
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValueOnce({ affected: 0 });

      const results = await Promise.allSettled([
        service.decide(rev1, 'app1', ReviewDecision.APPROVED),
        service.decide(rev1, 'app1', ReviewDecision.REJECTED, 'no'),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(audit.record).toHaveBeenCalledTimes(1);
    });
  });
});
