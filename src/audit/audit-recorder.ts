import { EntityManager } from 'typeorm';
import { AuthUser } from '../auth/auth-user.interface';
import { AuditAction } from './audit-action.enum';

export interface AuditEvent {
  action: AuditAction;
  /** null for system actions such as the risk-review worker. */
  actor: Pick<AuthUser, 'id' | 'role'> | null;
  entityType: string;
  /** null when no entity exists, e.g. a login attempt for an unknown email. */
  entityId: string | null;
  /**
   * Free-form detail. It is sanitized before storage (secrets redacted, emails
   * and phones masked), but still: pass ids, enums and counts, not personal data.
   */
  metadata?: Record<string, unknown>;
  /**
   * Overrides the correlation id. By default the current HTTP request id is
   * used; the risk-review worker passes its job id.
   */
  correlationId?: string;
}

/**
 * The seam between business code and the audit trail.
 *
 * For a state-changing action, pass the EntityManager of the transaction that
 * makes the change: the audit row then commits or rolls back together with it,
 * so the trail can neither miss a change nor describe one that never happened.
 */
export abstract class AuditRecorder {
  abstract record(event: AuditEvent, manager?: EntityManager): Promise<void>;
}
