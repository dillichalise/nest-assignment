import { Queue } from 'bullmq';
import { ApplicationStatus } from '../applications/enums/application-status.enum';
import { fakeDataSource } from '../common/testing/fake-data-source';
import { RiskStatus } from '../applications/enums/risk-status.enum';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditRecorder } from '../audit/audit-recorder';
import { RiskReviewService } from './risk-review.service';
import { riskReviewJobId } from './risk-review.types';

describe('RiskReviewService', () => {
  let queue: { add: jest.Mock };
  let repo: { update: jest.Mock };
  let tx: ReturnType<typeof fakeDataSource>;
  let audit: { record: jest.Mock };
  let service: RiskReviewService;

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation();
    queue = { add: jest.fn().mockResolvedValue({}) };
    repo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    tx = fakeDataSource(repo);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new RiskReviewService(
      queue as unknown as Queue,
      tx.dataSource,
      audit as unknown as AuditRecorder,
    );
  });

  describe('enqueue', () => {
    it('adds a job with a deterministic id and an ids-only payload', async () => {
      await expect(service.enqueue('app-1', 2)).resolves.toBe(true);

      const [name, data, opts] = queue.add.mock.calls[0];
      expect(name).toBe('assess');
      expect(data).toEqual({ applicationId: 'app-1', run: 2 });
      expect(opts).toEqual({ jobId: 'risk-review-app-1-2' });
      expect(opts.jobId).toBe(riskReviewJobId('app-1', 2));
    });

    it('never puts business data or personal data in the payload', async () => {
      await service.enqueue('app-1', 1);
      const data = queue.add.mock.calls[0][1];
      expect(Object.keys(data).sort()).toEqual(['applicationId', 'run']);
    });

    it('uses the same job id for the same request, a different one for a new run', () => {
      expect(riskReviewJobId('a', 1)).toBe(riskReviewJobId('a', 1));
      expect(riskReviewJobId('a', 1)).not.toBe(riskReviewJobId('a', 2));
      expect(riskReviewJobId('a', 1)).not.toBe(riskReviewJobId('b', 1));
    });

    it('avoids colons, which BullMQ restricts in custom ids', () => {
      expect(
        riskReviewJobId('6f1c0e7e-6d0b-4a53-9a4b-2f2a9d8c1b11', 12),
      ).not.toContain(':');
    });

    it('compensates a failed enqueue by marking the review FAILED, and reports false', async () => {
      queue.add.mockRejectedValue(new Error('redis is down'));

      await expect(service.enqueue('app-1', 2)).resolves.toBe(false);

      const [where, patch] = repo.update.mock.calls[0];
      expect(where).toEqual({
        id: 'app-1',
        riskReviewRun: 2,
        riskStatus: RiskStatus.PENDING,
      });
      expect(patch).toMatchObject({
        riskStatus: RiskStatus.FAILED,
        riskResult: { failure: { code: 'ENQUEUE_FAILED', attempts: 0 } },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.RISK_REVIEW_FAILED }),
        tx.manager,
      );
    });
  });

  describe('markCompleted', () => {
    const assessment = {
      score: 42,
      level: 'MEDIUM' as const,
      flags: ['HIGH_VOLUME'],
      provider: 'simulated-kyb',
      reference: 'SIM-abc',
    };

    it('writes the result only for this run, while still PENDING and reviewable', async () => {
      await expect(service.markCompleted('app-1', 3, assessment)).resolves.toBe(
        true,
      );

      const [where, patch] = repo.update.mock.calls[0];
      expect(where.id).toBe('app-1');
      expect(where.riskReviewRun).toBe(3);
      expect(where.riskStatus).toBe(RiskStatus.PENDING);
      expect(where.status._value).toEqual([
        ApplicationStatus.SUBMITTED,
        ApplicationStatus.IN_REVIEW,
      ]);
      expect(patch).toEqual({
        riskStatus: RiskStatus.COMPLETED,
        riskScore: 42,
        riskResult: assessment,
      });
    });

    it('audits completion once, with the score and level but no raw detail', async () => {
      await service.markCompleted('app-1', 3, assessment);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        {
          action: AuditAction.RISK_REVIEW_COMPLETED,
          actor: null,
          entityType: 'MerchantApplication',
          entityId: 'app-1',
          metadata: { run: 3, score: 42, level: 'MEDIUM' },
        },
        tx.manager,
      );
    });

    it('changes nothing and audits nothing when the run was superseded or already applied', async () => {
      repo.update.mockResolvedValue({ affected: 0 });
      await expect(service.markCompleted('app-1', 1, assessment)).resolves.toBe(
        false,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('markFailed', () => {
    it('stores only a code and the attempt count, never raw error text', async () => {
      await service.markFailed('app-1', 2, 'PROVIDER_UNAVAILABLE', 3);

      const patch = repo.update.mock.calls[0][1];
      expect(patch).toEqual({
        riskStatus: RiskStatus.FAILED,
        riskScore: null,
        riskResult: { failure: { code: 'PROVIDER_UNAVAILABLE', attempts: 3 } },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.RISK_REVIEW_FAILED,
          actor: null,
          metadata: { run: 2, code: 'PROVIDER_UNAVAILABLE', attempts: 3 },
        }),
        tx.manager,
      );
    });

    it('does nothing for a superseded or already-finished run', async () => {
      repo.update.mockResolvedValue({ affected: 0 });
      await expect(service.markFailed('app-1', 1, 'X', 1)).resolves.toBe(false);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('transactions and correlation', () => {
    const assessment = {
      score: 42,
      level: 'MEDIUM' as const,
      flags: [],
      provider: 'simulated-kyb',
      reference: 'SIM-abc',
    };

    it('markCompleted: the result and its audit record share one transaction', async () => {
      await service.markCompleted('app-1', 1, assessment);

      expect(tx.transaction).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0][1]).toBe(tx.manager);
      expect(repo.update.mock.invocationCallOrder[0]).toBeLessThan(
        audit.record.mock.invocationCallOrder[0],
      );
    });

    it('markCompleted: a failing audit write aborts the result write (fail closed)', async () => {
      audit.record.mockRejectedValue(new Error('audit table unavailable'));
      await expect(
        service.markCompleted('app-1', 1, assessment),
      ).rejects.toThrow('audit table unavailable');
    });

    it('markFailed: the failure and its audit record share one transaction', async () => {
      await service.markFailed('app-1', 1, 'PROVIDER_UNAVAILABLE', 3);
      expect(tx.transaction).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0][1]).toBe(tx.manager);
    });

    it('marks the audit event with the job id when one is given (worker), and none otherwise (HTTP)', async () => {
      await service.markCompleted(
        'app-1',
        1,
        assessment,
        'risk-review-app-1-1',
      );
      await service.markFailed('app-2', 1, 'X', 1, 'risk-review-app-2-1');
      await service.markFailed('app-3', 1, 'X', 1);

      expect(audit.record.mock.calls[0][0].correlationId).toBe(
        'risk-review-app-1-1',
      );
      expect(audit.record.mock.calls[1][0].correlationId).toBe(
        'risk-review-app-2-1',
      );
      // undefined: AuditService then falls back to the current request id
      expect(audit.record.mock.calls[2][0].correlationId).toBeUndefined();
    });

    it('a superseded run opens a transaction but writes and audits nothing', async () => {
      repo.update.mockResolvedValue({ affected: 0 });
      await service.markCompleted('app-1', 1, assessment);
      await service.markFailed('app-1', 1, 'X', 1);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
