import { ApiProperty } from '@nestjs/swagger';
import { AuditAction } from '../audit-action.enum';
import { AuditLog } from '../audit-log.entity';

export class AuditLogResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;

  @ApiProperty({ enum: AuditAction })
  action!: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'null for system actions such as the risk-review worker.',
  })
  actorId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ADMIN' })
  actorRole!: string | null;

  @ApiProperty({ example: 'MerchantApplication' }) entityType!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) entityId!: string | null;

  @ApiProperty({
    type: Object,
    description:
      'Sanitized detail: secrets removed, emails and phone numbers masked.',
  })
  metadata!: Record<string, unknown>;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'HTTP request id (matches the x-request-id response header and the access log) or, for background work, the job id.',
  })
  correlationId!: string | null;

  @ApiProperty() createdAt!: Date;

  static from(log: AuditLog): AuditLogResponseDto {
    const dto = new AuditLogResponseDto();
    dto.id = log.id;
    dto.action = log.action;
    dto.actorId = log.actorId;
    dto.actorRole = log.actorRole;
    dto.entityType = log.entityType;
    dto.entityId = log.entityId;
    dto.metadata = log.metadata;
    dto.correlationId = log.correlationId;
    dto.createdAt = log.createdAt;
    return dto;
  }
}

export class PaginatedAuditLogsDto {
  @ApiProperty({ type: [AuditLogResponseDto] })
  items!: AuditLogResponseDto[];

  @ApiProperty({ example: 7, description: 'Total rows across all pages' })
  total!: number;

  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
}
