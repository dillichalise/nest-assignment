import { HttpStatus } from '@nestjs/common';
import { DomainError } from '../common/errors/domain.error';
import { ApplicationStatus } from './enums/application-status.enum';

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
