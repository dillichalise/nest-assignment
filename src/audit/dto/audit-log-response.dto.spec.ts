import { AuditAction } from '../audit-action.enum';
import { AuditLog } from '../audit-log.entity';
import { AuditLogResponseDto } from './audit-log-response.dto';

describe('AuditLogResponseDto.from', () => {
  const log = {
    id: '6f1c0e7e-6d0b-4a53-9a4b-2f2a9d8c1b11',
    actorId: 'a1',
    actorRole: 'ADMIN',
    action: AuditAction.REVIEWER_ASSIGNED,
    entityType: 'MerchantApplication',
    entityId: 'e1',
    metadata: { reviewerId: 'r1' },
    correlationId: 'req-1',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  } as AuditLog;

  it('copies exactly the documented fields', () => {
    const dto = AuditLogResponseDto.from(log);
    expect(dto).toEqual({
      id: log.id,
      action: AuditAction.REVIEWER_ASSIGNED,
      actorId: 'a1',
      actorRole: 'ADMIN',
      entityType: 'MerchantApplication',
      entityId: 'e1',
      metadata: { reviewerId: 'r1' },
      correlationId: 'req-1',
      createdAt: log.createdAt,
    });
  });

  it('never exposes columns that are not in the explicit list', () => {
    const withExtra = {
      ...log,
      internalNote: 'x',
      passwordHash: 'h',
    } as unknown as AuditLog;
    const dto = AuditLogResponseDto.from(withExtra) as unknown as Record<
      string,
      unknown
    >;
    expect(dto).not.toHaveProperty('internalNote');
    expect(dto).not.toHaveProperty('passwordHash');
  });

  it('keeps null actor and correlation id for system events', () => {
    const dto = AuditLogResponseDto.from({
      ...log,
      actorId: null,
      actorRole: null,
      correlationId: null,
    } as AuditLog);
    expect(dto.actorId).toBeNull();
    expect(dto.actorRole).toBeNull();
    expect(dto.correlationId).toBeNull();
  });
});
