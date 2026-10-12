import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from './error-response.dto';

const DESCRIPTIONS: Record<number, string> = {
  400: 'Validation failed. `details` lists every invalid field.',
  401: 'Missing, malformed, invalid or expired token (or, for login, wrong credentials).',
  403: 'Your role is not allowed to do this.',
  404: 'Not found, or not visible to you. The two are deliberately indistinguishable.',
  409: 'Conflicts with the current state: an invalid status change, a locked application, a decision already made, or a lost race with another request.',
  422: 'The request is well-formed but breaks a business rule (see `message` and `details`).',
  500: 'Unexpected server error. The message is generic; use the `requestId` to find the cause in the logs.',
  503: 'A dependency (the job queue) is temporarily unavailable. Safe to retry.',
};

/** Documents the shared error body, with a plain-language description, for the given status codes. */
export const ApiErrorResponses = (...statuses: number[]) =>
  applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: DESCRIPTIONS[status] ?? 'Error',
        type: ErrorResponseDto,
      }),
    ),
  );
