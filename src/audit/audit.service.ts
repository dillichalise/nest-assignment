import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { getRequestId } from '../common/context/request-context';
import { sanitizeAuditMetadata } from './audit-metadata-sanitizer';
import { AuditLog } from './audit-log.entity';
import { AuditEvent, AuditRecorder } from './audit-recorder';

export interface AuditPage {
  items: AuditLog[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Writes and reads the audit trail.
 *
 * `record` is the ONLY write path and there is deliberately no update or
 * delete method; the table's trigger enforces the same thing in the database.
 */
@Injectable()
export class AuditService extends AuditRecorder {
  constructor(
    @InjectRepository(AuditLog) private readonly logs: Repository<AuditLog>,
  ) {
    super();
  }

  async record(event: AuditEvent, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(AuditLog) : this.logs;
    await repo.insert({
      actorId: event.actor?.id ?? null,
      actorRole: event.actor?.role ?? null,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      // TypeORM's insert typing cannot express an arbitrary JSON document.
      metadata: sanitizeAuditMetadata(
        event.metadata,
      ) as QueryDeepPartialEntity<AuditLog>['metadata'],
      correlationId: event.correlationId ?? getRequestId() ?? null,
    });
  }

  /** Oldest first, so the result reads as the history of the entity. */
  async listForEntity(
    entityType: string,
    entityId: string,
    { page, limit }: { page: number; limit: number },
  ): Promise<AuditPage> {
    const [items, total] = await this.logs.findAndCount({
      where: { entityType, entityId },
      // id breaks ties between rows written in the same microsecond.
      order: { createdAt: 'ASC', id: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit };
  }
}
