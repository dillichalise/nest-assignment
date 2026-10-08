import {
  ArgumentsHost,
  BadRequestException,
  Logger,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { ConflictError, NotFoundError } from '../errors/domain.error';
import { AllExceptionsFilter } from './all-exceptions.filter';

const run = (exception: unknown) => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'GET',
        url: '/things?x=1',
        requestId: 'req-1',
      }),
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { code: status.mock.calls[0][0], body: json.mock.calls[0][0] };
};

describe('AllExceptionsFilter', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('maps validation errors to 400 with details', () => {
    const { code, body } = run(
      new BadRequestException({
        message: 'Validation failed',
        details: [{ field: 'email', errors: ['bad'] }],
      }),
    );
    expect(code).toBe(400);
    expect(body.message).toBe('Validation failed');
    expect(body.details).toEqual([{ field: 'email', errors: ['bad'] }]);
  });

  it('maps array messages from built-in pipes to details', () => {
    const { code, body } = run(new BadRequestException(['a must be x']));
    expect(code).toBe(400);
    expect(body.details).toEqual(['a must be x']);
  });

  it.each([
    [new ConflictError('Invalid transition'), 409],
    [new NotFoundError('Not found'), 404],
    [new UnauthorizedException(), 401],
    [new ForbiddenException(), 403],
  ])('maps %p to %i', (err, expected) => {
    expect(run(err).code).toBe(expected);
  });

  it('maps a unique violation to 409 without leaking SQL', () => {
    const err = new QueryFailedError('INSERT secret_sql', [], {
      code: '23505',
    } as any);
    const { code, body } = run(err);
    expect(code).toBe(409);
    expect(JSON.stringify(body)).not.toContain('secret_sql');
  });

  it('hides unknown errors behind a generic 500', () => {
    const { code, body } = run(new Error('db password is hunter2'));
    expect(code).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('includes request id, path without query, and timestamp', () => {
    const { body } = run(new NotFoundError('x'));
    expect(body.requestId).toBe('req-1');
    expect(body.path).toBe('/things');
    expect(body.timestamp).toEqual(expect.any(String));
    expect(body.error).toBe('Not Found');
  });
});
