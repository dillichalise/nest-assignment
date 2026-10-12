import { In, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditRecorder } from '../audit/audit-recorder';
import { AuthUser } from '../auth/auth-user.interface';
import { Role } from '../common/enums/role.enum';
import { NotFoundError } from '../common/errors/domain.error';
import { fakeDataSource } from '../common/testing/fake-data-source';
import { PolicyService } from '../policies/policy.service';
import { ApplicationNotEditableError } from './application.errors';
import { ApplicationsService } from './applications.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
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
const reviewer = user('rev1', Role.REVIEWER);

const makeApp = (over: Partial<MerchantApplication> = {}) =>
  ({
    id: 'app1',
    createdById: 'salesA',
    assignedReviewerId: null,
    status: S.DRAFT,
    ...over,
  }) as MerchantApplication;

describe('ApplicationsService', () => {
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    findOneBy: jest.Mock;
    findOneByOrFail: jest.Mock;
    findAndCount: jest.Mock;
    update: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let tx: ReturnType<typeof fakeDataSource>;
  let service: ApplicationsService;

  beforeEach(() => {
    repo = {
      create: jest.fn((x) => x),
      save: jest.fn((x) => Promise.resolve(x)),
      findOneBy: jest.fn(),
      findOneByOrFail: jest.fn(),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    tx = fakeDataSource(repo);
    service = new ApplicationsService(
      repo as unknown as Repository<MerchantApplication>,
      new PolicyService(),
      tx.dataSource,
      audit as unknown as AuditRecorder,
    );
  });

  describe('create', () => {
    it('stamps owner, DRAFT and NOT_STARTED server-side, ignoring any smuggled fields', async () => {
      const dto = {
        businessName: 'Cafe',
        // Smuggled fields that a client might add; the DTO type does not have them.
        status: S.APPROVED,
        createdById: 'someone-else',
        riskStatus: RiskStatus.COMPLETED,
      } as unknown as CreateApplicationDto;

      repo.findOneByOrFail.mockImplementation(({ id }) =>
        Promise.resolve({ ...repo.save.mock.calls[0][0], id }),
      );
      repo.save.mockImplementation((x) =>
        Promise.resolve({ ...x, id: 'new-id' }),
      );

      const saved = await service.create(salesA, dto);

      expect(saved.createdById).toBe('salesA');
      expect(saved.status).toBe(S.DRAFT);
      expect(saved.riskStatus).toBe(RiskStatus.NOT_STARTED);
    });
  });

  describe('create: audit', () => {
    const setup = () => {
      repo.save.mockImplementation((x) =>
        Promise.resolve({ ...x, id: 'new-id' }),
      );
      repo.findOneByOrFail.mockResolvedValue(makeApp({ id: 'new-id' }));
    };

    it('writes the row and its audit record inside ONE transaction', async () => {
      setup();
      await service.create(salesA, {
        businessName: 'Cafe',
      } as CreateApplicationDto);

      expect(tx.transaction).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledTimes(1);
      // the audit write receives the transaction's manager, so it joins it
      expect(audit.record.mock.calls[0][1]).toBe(tx.manager);
      expect(audit.record.mock.calls[0][0]).toEqual({
        action: AuditAction.APPLICATION_CREATED,
        actor: salesA,
        entityType: 'MerchantApplication',
        entityId: 'new-id',
        metadata: { initialStatus: S.DRAFT },
      });
    });

    it('records the audit entry after the row is saved', async () => {
      setup();
      await service.create(salesA, {
        businessName: 'Cafe',
      } as CreateApplicationDto);
      expect(repo.save.mock.invocationCallOrder[0]).toBeLessThan(
        audit.record.mock.invocationCallOrder[0],
      );
    });

    it('lets a failing audit write abort the creation (the transaction rolls back)', async () => {
      setup();
      audit.record.mockRejectedValue(new Error('audit table unavailable'));
      await expect(
        service.create(salesA, {
          businessName: 'Cafe',
        } as CreateApplicationDto),
      ).rejects.toThrow('audit table unavailable');
    });

    it('puts no personal data in the audit metadata', async () => {
      setup();
      await service.create(salesA, {
        businessName: 'Cafe',
        ownerEmail: 'pat@example.com',
        ownerTaxId: '123-456-789',
      } as CreateApplicationDto);
      const json = JSON.stringify(audit.record.mock.calls[0][0]);
      expect(json).not.toContain('pat@example.com');
      expect(json).not.toContain('123-456-789');
    });
  });

  describe('findOne', () => {
    it('returns the application to its owner and to ADMIN', async () => {
      repo.findOneBy.mockResolvedValue(makeApp());
      await expect(service.findOne(salesA, 'app1')).resolves.toBeDefined();
      await expect(service.findOne(admin, 'app1')).resolves.toBeDefined();
    });

    it('gives another SALES user the same NotFoundError as a missing id', async () => {
      repo.findOneBy.mockResolvedValue(makeApp());
      const hidden = await service.findOne(salesB, 'app1').catch((e) => e);

      repo.findOneBy.mockResolvedValue(null);
      const missing = await service.findOne(salesB, 'nope').catch((e) => e);

      expect(hidden).toBeInstanceOf(NotFoundError);
      expect(missing).toBeInstanceOf(NotFoundError);
      expect(hidden.message).toBe(missing.message);
      expect(hidden.status).toBe(missing.status);
    });

    it('lets a REVIEWER read only applications assigned to them', async () => {
      repo.findOneBy.mockResolvedValue(makeApp({ assignedReviewerId: 'rev1' }));
      await expect(service.findOne(reviewer, 'app1')).resolves.toBeDefined();

      repo.findOneBy.mockResolvedValue(
        makeApp({ assignedReviewerId: 'other' }),
      );
      await expect(service.findOne(reviewer, 'app1')).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('update', () => {
    it('updates an editable application with a status-conditional UPDATE', async () => {
      repo.findOneBy.mockResolvedValue(makeApp({ status: S.INFO_REQUESTED }));
      repo.findOneByOrFail.mockResolvedValue(makeApp());

      await service.update(salesA, 'app1', { businessName: 'New' });

      const [where, patch] = repo.update.mock.calls[0];
      expect(where.id).toBe('app1');
      expect(where.status).toEqual(In([S.DRAFT, S.INFO_REQUESTED]));
      expect(patch).toEqual({ businessName: 'New' });
    });

    it('audits the update with field NAMES only, in the same transaction', async () => {
      repo.findOneBy.mockResolvedValue(makeApp());
      repo.findOneByOrFail.mockResolvedValue(makeApp());

      await service.update(salesA, 'app1', {
        ownerTaxId: '999-888-777',
        businessName: 'Renamed',
        ownerEmail: 'new@example.com',
      });

      expect(audit.record).toHaveBeenCalledTimes(1);
      const [event, manager] = audit.record.mock.calls[0];
      expect(manager).toBe(tx.manager);
      expect(event).toEqual({
        action: AuditAction.APPLICATION_UPDATED,
        actor: salesA,
        entityType: 'MerchantApplication',
        entityId: 'app1',
        metadata: {
          changedFields: ['businessName', 'ownerEmail', 'ownerTaxId'],
        },
      });
      // values never reach the trail
      const json = JSON.stringify(event);
      for (const value of ['999-888-777', 'Renamed', 'new@example.com']) {
        expect(json).not.toContain(value);
      }
    });

    it.each([
      ['nothing changed', makeApp(), { businessName: undefined }],
      [
        'the application is locked',
        makeApp({ status: S.APPROVED }),
        { businessName: 'x' },
      ],
      [
        'another SALES user tries',
        makeApp({ createdById: 'other' }),
        { businessName: 'x' },
      ],
    ])('writes no audit record when %s', async (_n, app, dto) => {
      repo.findOneBy.mockResolvedValue(app);
      await service.update(salesA, 'app1', dto).catch(() => undefined);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('writes no audit record when a concurrent submit won the race (0 rows updated)', async () => {
      repo.findOneBy.mockResolvedValue(makeApp());
      repo.update.mockResolvedValue({ affected: 0 });
      await service
        .update(salesA, 'app1', { businessName: 'x' })
        .catch(() => undefined);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('drops undefined fields and skips the UPDATE when nothing changed', async () => {
      repo.findOneBy.mockResolvedValue(makeApp());
      await service.update(salesA, 'app1', { businessName: undefined });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it.each([S.SUBMITTED, S.IN_REVIEW, S.APPROVED, S.REJECTED])(
      'rejects edits in %s with a 409-style domain error',
      async (status) => {
        repo.findOneBy.mockResolvedValue(makeApp({ status }));
        const err = await service
          .update(salesA, 'app1', { businessName: 'x' })
          .catch((e) => e);
        expect(err).toBeInstanceOf(ApplicationNotEditableError);
        expect(err.status).toBe(409);
        expect(err.details).toEqual({ currentStatus: status });
        expect(repo.update).not.toHaveBeenCalled();
      },
    );

    it('never lets another SALES user edit or learn the state: 404, not 409', async () => {
      repo.findOneBy.mockResolvedValue(makeApp({ status: S.APPROVED }));
      await expect(
        service.update(salesB, 'app1', { businessName: 'x' }),
      ).rejects.toThrow(NotFoundError);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('a REVIEWER cannot edit even an application assigned to them', async () => {
      repo.findOneBy.mockResolvedValue(makeApp({ assignedReviewerId: 'rev1' }));
      await expect(
        service.update(reviewer, 'app1', { businessName: 'x' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('ADMIN may edit any editable application', async () => {
      repo.findOneBy.mockResolvedValue(makeApp());
      repo.findOneByOrFail.mockResolvedValue(makeApp());
      await expect(
        service.update(admin, 'app1', { businessName: 'x' }),
      ).resolves.toBeDefined();
    });

    it('returns 409 when a concurrent submit won the race (0 rows updated)', async () => {
      repo.findOneBy.mockResolvedValue(makeApp());
      repo.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.update(salesA, 'app1', { businessName: 'x' }),
      ).rejects.toThrow(ApplicationNotEditableError);
    });

    it('returns NotFoundError for a missing application', async () => {
      repo.findOneBy.mockResolvedValue(null);
      await expect(
        service.update(salesA, 'nope', { businessName: 'x' }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('list', () => {
    const query = (over: Partial<ListApplicationsQueryDto> = {}) =>
      Object.assign(new ListApplicationsQueryDto(), over);

    it('scopes SALES to their own applications', async () => {
      await service.list(salesA, query());
      expect(repo.findAndCount.mock.calls[0][0].where).toEqual({
        createdById: 'salesA',
      });
    });

    it('scopes REVIEWER to assigned applications and ADMIN to everything', async () => {
      await service.list(reviewer, query());
      expect(repo.findAndCount.mock.calls[0][0].where).toEqual({
        assignedReviewerId: 'rev1',
      });
      await service.list(admin, query());
      expect(repo.findAndCount.mock.calls[1][0].where).toEqual({});
    });

    it('combines the status filter with the scope, never replacing it', async () => {
      await service.list(salesA, query({ status: S.SUBMITTED }));
      expect(repo.findAndCount.mock.calls[0][0].where).toEqual({
        createdById: 'salesA',
        status: S.SUBMITTED,
      });
    });

    it('paginates with stable ordering and returns page metadata', async () => {
      repo.findAndCount.mockResolvedValue([[makeApp()], 41]);
      const result = await service.list(admin, query({ page: 3, limit: 10 }));

      const args = repo.findAndCount.mock.calls[0][0];
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
      expect(args.order).toEqual({ createdAt: 'DESC', id: 'DESC' });
      expect(result).toMatchObject({ total: 41, page: 3, limit: 10 });
    });

    it('uses defaults of page 1 and limit 20', async () => {
      await service.list(admin, query());
      const args = repo.findAndCount.mock.calls[0][0];
      expect(args.skip).toBe(0);
      expect(args.take).toBe(20);
    });
  });
});
