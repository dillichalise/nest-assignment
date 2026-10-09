import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuthUser } from '../auth/auth-user.interface';
import { Role } from '../common/enums/role.enum';
import { NotFoundError } from '../common/errors/domain.error';

/**
 * The minimal shape the policies need.
 */
export interface ApplicationAccessSubject {
  createdById: string;
  assignedReviewerId: string | null;
}

/** Row filter equivalent to `canViewApplication` for list queries. */
export interface ApplicationScope {
  createdById?: string;
  assignedReviewerId?: string;
}

/**
 * Object-level authorization rules. Role checks (guards) answer "may this role
 * call the endpoint at all"; these answer "may this user touch THIS object".
 *
 * Denial convention: when the user must not learn that the object exists
 * (view/edit), we throw NotFoundError (404) - indistinguishable from a
 * missing id. When they may see it but not perform the action (decide), 403.
 */
@Injectable()
export class PolicyService {
  canViewApplication(user: AuthUser, app: ApplicationAccessSubject): boolean {
    switch (user.role) {
      case Role.ADMIN:
        return true;
      case Role.SALES:
        return app.createdById === user.id;
      case Role.REVIEWER:
        return app.assignedReviewerId === user.id;
      default:
        return false;
    }
  }

  /**
   * The same visibility rule as `canViewApplication`, expressed as a query
   * filter, so list endpoints cannot drift from single-object access.
   */
  applicationScope(user: AuthUser): ApplicationScope {
    switch (user.role) {
      case Role.ADMIN:
        return {};
      case Role.SALES:
        return { createdById: user.id };
      case Role.REVIEWER:
        return { assignedReviewerId: user.id };
      default:
        // Unknown role: fail closed.
        throw new ForbiddenException();
    }
  }

  canEditApplication(user: AuthUser, app: ApplicationAccessSubject): boolean {
    return (
      user.role === Role.ADMIN ||
      (user.role === Role.SALES && app.createdById === user.id)
    );
  }

  /** Only the assigned reviewer; deliberately no ADMIN override. */
  canDecideApplication(user: AuthUser, app: ApplicationAccessSubject): boolean {
    return user.role === Role.REVIEWER && app.assignedReviewerId === user.id;
  }

  /** Assigning reviewers is an ADMIN-only operational action. */
  canAssignReviewer(user: AuthUser): boolean {
    return user.role === Role.ADMIN;
  }

  assertCanAssignReviewer(user: AuthUser): void {
    if (!this.canAssignReviewer(user)) {
      throw new ForbiddenException('Only an admin may assign reviewers');
    }
  }

  assertCanView(user: AuthUser, app: ApplicationAccessSubject): void {
    if (!this.canViewApplication(user, app)) {
      throw new NotFoundError('Application not found');
    }
  }

  assertCanEdit(user: AuthUser, app: ApplicationAccessSubject): void {
    if (!this.canEditApplication(user, app)) {
      throw new NotFoundError('Application not found');
    }
  }

  assertCanDecide(user: AuthUser, app: ApplicationAccessSubject): void {
    if (this.canDecideApplication(user, app)) {
      return;
    }
    if (!this.canViewApplication(user, app)) {
      throw new NotFoundError('Application not found');
    }
    throw new ForbiddenException('Only the assigned reviewer may decide');
  }
}
