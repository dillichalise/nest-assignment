import { AuthUser } from '../auth/auth-user.interface';
import { AuditAction } from './audit-action.enum';

export interface AuditEvent {
  action: AuditAction;
  /** null for system actions such as the risk-review worker. */
  actor: Pick<AuthUser, 'id' | 'role'> | null;
  entityType: string;
  entityId: string;
  /** Never put passwords, tokens or raw secrets here. */
  metadata?: Record<string, unknown>;
}

/**
 * The seam between business code and the audit trail. Callers depend on this
 * abstract class.
 */
export abstract class AuditRecorder {
  abstract record(event: AuditEvent): Promise<void>;
}
