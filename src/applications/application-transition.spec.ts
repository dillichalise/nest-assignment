import { Repository } from 'typeorm';
import { ConflictError } from '../common/errors/domain.error';
import { applyTransition } from './application-transition';
import { InvalidStateTransitionError } from './application.errors';
import { ApplicationStatus as S } from './enums/application-status.enum';
import { MerchantApplication } from './merchant-application.entity';

describe('applyTransition', () => {
  const makeRepo = (affected: number) => {
    const update = jest.fn().mockResolvedValue({ affected });
    return {
      repo: { update } as unknown as Repository<MerchantApplication>,
      update,
    };
  };

  it('updates conditionally on the expected current status', async () => {
    const { repo, update } = makeRepo(1);
    await applyTransition(repo, 'app1', S.DRAFT, S.SUBMITTED, {
      submittedAt: new Date('2026-01-01'),
    });
    expect(update).toHaveBeenCalledWith(
      { id: 'app1', status: S.DRAFT },
      { submittedAt: new Date('2026-01-01'), status: S.SUBMITTED },
    );
  });

  it('lets the new status win over anything in the patch', async () => {
    const { repo, update } = makeRepo(1);
    await applyTransition(repo, 'app1', S.DRAFT, S.SUBMITTED, {
      status: S.APPROVED,
    });
    expect(update.mock.calls[0][1].status).toBe(S.SUBMITTED);
  });

  it('throws 409 when another request already changed the status (lost race)', async () => {
    const { repo } = makeRepo(0);
    await expect(
      applyTransition(repo, 'app1', S.IN_REVIEW, S.APPROVED),
    ).rejects.toThrow(ConflictError);
  });

  it('rejects an invalid transition without touching the database', async () => {
    const { repo, update } = makeRepo(1);
    await expect(
      applyTransition(repo, 'app1', S.APPROVED, S.DRAFT),
    ).rejects.toThrow(InvalidStateTransitionError);
    expect(update).not.toHaveBeenCalled();
  });

  it('only one of two concurrent identical transitions succeeds', async () => {
    // Simulates Postgres: the first UPDATE matches the row, the second finds it already moved.
    const update = jest
      .fn()
      .mockResolvedValueOnce({ affected: 1 })
      .mockResolvedValueOnce({ affected: 0 });
    const repo = { update } as unknown as Repository<MerchantApplication>;

    const results = await Promise.allSettled([
      applyTransition(repo, 'app1', S.IN_REVIEW, S.APPROVED),
      applyTransition(repo, 'app1', S.IN_REVIEW, S.APPROVED),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
  });
});
