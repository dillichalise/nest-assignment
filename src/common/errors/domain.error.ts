import { HttpStatus } from '@nestjs/common';

/**
 * Base class for business-rule violations. Services throw these instead of
 * HTTP exceptions; the global exception filter maps them to HTTP responses.
 */
export abstract class DomainError extends Error {
  abstract readonly status: HttpStatus;
  abstract readonly code: string;

  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Resource missing, or hidden from the caller (object-level denial). */
export class NotFoundError extends DomainError {
  readonly status = HttpStatus.NOT_FOUND;
  readonly code = 'NOT_FOUND';
}

/** Request conflicts with current state (e.g. invalid status transition). */
export class ConflictError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly code = 'CONFLICT';
}

/** Request is well-formed but violates a business rule. */
export class UnprocessableError extends DomainError {
  readonly status = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly code = 'UNPROCESSABLE';
}
