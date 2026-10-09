import { HttpStatus } from '@nestjs/common';
import { DomainError } from '../common/errors/domain.error';
import { ApplicationStatus } from './enums/application-status.enum';
import { RiskStatus } from './enums/risk-status.enum';

/** Requested status change is not allowed from the current status. */
export class InvalidStateTransitionError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly code = 'INVALID_STATE_TRANSITION';

  constructor(from: ApplicationStatus, to: ApplicationStatus) {
    super(`Cannot change application status from ${from} to ${to}`, {
      from,
      to,
    });
  }
}

/** The application's data may only change while DRAFT or INFO_REQUESTED. */
export class ApplicationNotEditableError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly code = 'APPLICATION_NOT_EDITABLE';

  constructor(currentStatus?: ApplicationStatus) {
    super(
      'Application can only be edited while in DRAFT or INFO_REQUESTED status',
      currentStatus ? { currentStatus } : undefined,
    );
  }
}

/** A decision needs a finished risk review first. */
export class RiskReviewNotCompleteError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly code = 'RISK_REVIEW_NOT_COMPLETE';

  constructor(riskStatus: RiskStatus) {
    super(
      'A decision can only be recorded after the risk review has completed',
      {
        riskStatus,
      },
    );
  }
}
