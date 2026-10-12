import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { runWithRequestContext } from '../common/context/request-context';
import { createValidationPipe } from '../common/pipes/validation.pipe';
import { Role } from '../common/enums/role.enum';
import { AuditAction } from './audit-action.enum';
import { AuditLog } from './audit-log.entity';
import { AuditEvent } from './audit-recorder';
import { AuditService } from './audit.service';
import { AuditLogsQueryDto } from './dto/audit-logs-query.dto';

const ID = '6f1c0e7e-6d0b-4a53-9a4b-2f2a9d8c1b11';

describe('AuditService', () => {
  let logs: { insert: jest.Mock; findAndCount: jest.Mock };
  let service: AuditService;

  const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
    action: AuditAction.APPLICATION_CREATED,
    actor: { id: 'u1', role: Role.SALES },
    entityType: 'MerchantApplication',
    entityId: ID,
    ...over,
  });

  beforeEach(() => {
    logs = {
      insert: jest.fn().mockResolvedValue(undefined),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    service = new AuditService(logs as unknown as Repository<AuditLog>);
  });

  describe('record', () => {
    it('inserts one row with the actor, action and entity', async () => {
      await service.record(event());

      expect(logs.insert).toHaveBeenCalledTimes(1);
      expect(logs.insert).toHaveBeenCalledWith({
        actorId: 'u1',
        actorRole: Role.SALES,
        action: AuditAction.APPLICATION_CREATED,
        entityType: 'MerchantApplication',
        entityId: ID,
        metadata: {},
        correlationId: null,
      });
    });

    it('stores a system action with no actor', async () => {
      await service.record(event({ actor: null }));
      expect(logs.insert.mock.calls[0][0]).toMatchObject({
        actorId: null,
        actorRole: null,
      });
    });

    it('stores an event with no entity (an unknown login attempt)', async () => {
      await service.record(event({ entityId: null }));
      expect(logs.insert.mock.calls[0][0].entityId).toBeNull();
    });

    it('writes through the given transaction manager instead of its own repository', async () => {
      const txRepo = { insert: jest.fn().mockResolvedValue(undefined) };
      const manager = {
        getRepository: jest.fn().mockReturnValue(txRepo),
      } as unknown as EntityManager;

      await service.record(event(), manager);

      expect(manager.getRepository).toHaveBeenCalledWith(AuditLog);
      expect(txRepo.insert).toHaveBeenCalledTimes(1);
      expect(logs.insert).not.toHaveBeenCalled();
    });

    it('propagates a write failure instead of swallowing it', async () => {
      logs.insert.mockRejectedValue(new Error('disk full'));
      await expect(service.record(event())).rejects.toThrow('disk full');
    });

    describe('metadata is always sanitized before it is stored', () => {
      it('redacts secrets and masks personal data', async () => {
        await service.record(
          event({
            metadata: {
              password: 'hunter2',
              token: 'abc.def',
              ownerTaxId: '123-456-789',
              email: 'pat@example.com',
              reason: 'call +977 9876543210',
              keep: 'ok',
            },
          }),
        );

        const stored = logs.insert.mock.calls[0][0].metadata;
        expect(stored).toMatchObject({
          password: '[REDACTED]',
          token: '[REDACTED]',
          ownerTaxId: '[REDACTED]',
          email: 'p**@example.com',
          keep: 'ok',
        });
        const json = JSON.stringify(stored);
        for (const raw of [
          'hunter2',
          'abc.def',
          '123-456-789',
          'pat@example.com',
          '9876543210',
        ]) {
          expect(json).not.toContain(raw);
        }
      });

      it('does not mutate the event it was given', async () => {
        const metadata = { password: 'hunter2' };
        await service.record(event({ metadata }));
        expect(metadata).toEqual({ password: 'hunter2' });
      });
    });

    describe('correlation id', () => {
      it('uses the current HTTP request id', async () => {
        await runWithRequestContext({ requestId: 'req-42' }, () =>
          service.record(event()),
        );
        expect(logs.insert.mock.calls[0][0].correlationId).toBe('req-42');
      });

      it('lets an explicit id (a job id) win over the request id', async () => {
        await runWithRequestContext({ requestId: 'req-42' }, () =>
          service.record(event({ correlationId: 'risk-review-app-1-1' })),
        );
        expect(logs.insert.mock.calls[0][0].correlationId).toBe(
          'risk-review-app-1-1',
        );
      });

      it('is null outside a request (scripts, workers without a job id)', async () => {
        await service.record(event());
        expect(logs.insert.mock.calls[0][0].correlationId).toBeNull();
      });
    });
  });

  describe('append-only', () => {
    it('exposes no update or delete operation', () => {
      const methods = Object.getOwnPropertyNames(AuditService.prototype);
      expect(methods.sort()).toEqual([
        'constructor',
        'listForEntity',
        'record',
      ]);
      for (const name of methods) {
        expect(name).not.toMatch(
          /update|delete|remove|save|upsert|truncate|clear/i,
        );
      }
    });
  });

  describe('listForEntity', () => {
    it('reads one entity, oldest first with a stable tie-break, paginated', async () => {
      logs.findAndCount.mockResolvedValue([[{ id: 'a' }], 41]);

      const page = await service.listForEntity('MerchantApplication', ID, {
        page: 3,
        limit: 10,
      });

      expect(logs.findAndCount).toHaveBeenCalledWith({
        where: { entityType: 'MerchantApplication', entityId: ID },
        order: { createdAt: 'ASC', id: 'ASC' },
        skip: 20,
        take: 10,
      });
      expect(page).toEqual({
        items: [{ id: 'a' }],
        total: 41,
        page: 3,
        limit: 10,
      });
    });
  });
});

describe('AuditLogsQueryDto', () => {
  const pipe = createValidationPipe();
  const run = (value: unknown) =>
    pipe.transform(value, {
      type: 'query',
      metatype: AuditLogsQueryDto,
    } as ArgumentMetadata) as Promise<AuditLogsQueryDto>;

  it('defaults to page 1, limit 20 and coerces strings', async () => {
    expect(await run({})).toMatchObject({ page: 1, limit: 20 });
    expect(await run({ page: '3', limit: '50' })).toMatchObject({
      page: 3,
      limit: 50,
    });
  });

  it.each([
    { limit: '101' },
    { limit: '0' },
    { page: '0' },
    { page: 'abc' },
    { limit: '1.5' },
  ])('rejects %p', async (query) => {
    await expect(run(query)).rejects.toThrow(BadRequestException);
  });
});
