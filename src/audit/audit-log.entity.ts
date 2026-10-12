import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One row per significant action. Append-only: the application has no update or
 * delete path, and a database trigger (see the CreateAuditLogs migration)
 * rejects UPDATE and DELETE.
 *
 * Deliberately no foreign keys: the trail must outlive the users and
 * applications it describes, so ids are stored as plain values.
 */
@Entity('audit_logs')
@Index(['entityType', 'entityId'])
@Index(['createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** null for system actions (the risk-review worker) and unknown login attempts. */
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  actorRole!: string | null;

  /** An AuditAction value. Stored as text so new actions need no migration. */
  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ type: 'varchar', length: 100 })
  entityType!: string;

  @Column({ type: 'uuid', nullable: true })
  entityId!: string | null;

  /** Already sanitized (see audit-metadata-sanitizer.ts). */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  /** The HTTP request id for API actions, the BullMQ job id for worker actions. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  correlationId!: string | null;

  /** clock_timestamp(), not now(): distinct per row even inside one transaction. */
  @Column({ type: 'timestamptz', default: () => 'clock_timestamp()' })
  createdAt!: Date;
}
