import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';
import { HttpLoggingMiddleware } from './http-logging.middleware';

const makeConfig = (values: Record<string, string>) =>
  ({
    get: (k: string, d?: string) => values[k] ?? d,
  }) as unknown as ConfigService;

const run = (
  config: Record<string, string>,
  req: Record<string, unknown>,
  status = 200,
) => {
  const res = Object.assign(new EventEmitter(), { statusCode: status });
  const next = jest.fn();
  new HttpLoggingMiddleware(makeConfig(config)).use(
    req as never,
    res as never,
    next,
  );
  res.emit('finish');
  return { next };
};

describe('HttpLoggingMiddleware', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  const base = {
    method: 'POST',
    originalUrl: '/auth/login?token=SECRET-IN-QUERY&x=1',
    requestId: 'req-1',
    user: { id: 'u1' },
    body: {
      email: 'pat@example.com',
      password: 'hunter2',
      ownerTaxId: '123-456-789',
      token: 'tok-123',
      nested: { authorization: 'Bearer abc' },
    },
    headers: { authorization: 'Bearer HEADER-SECRET' },
  };

  it('logs method, path, status, duration, request id and user id', () => {
    run({ NODE_ENV: 'development' }, base, 200);
    const line = log.mock.calls[0][0] as string;
    expect(line).toMatch(
      /^POST \/auth\/login 200 \d+ms requestId=req-1 userId=u1$/,
    );
  });

  it('never logs the query string, body or headers by default', () => {
    run({ NODE_ENV: 'development' }, base);
    const line = log.mock.calls[0][0] as string;
    for (const secret of [
      'SECRET-IN-QUERY',
      'hunter2',
      '123-456-789',
      'tok-123',
      'HEADER-SECRET',
      'pat@example.com',
    ]) {
      expect(line).not.toContain(secret);
    }
  });

  it('with LOG_HTTP_BODIES=true logs the body redacted, still without secrets', () => {
    run({ NODE_ENV: 'development', LOG_HTTP_BODIES: 'true' }, base);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('body=');
    expect(line).toContain('[REDACTED]');
    for (const secret of [
      'hunter2',
      '123-456-789',
      'tok-123',
      'Bearer abc',
      'SECRET-IN-QUERY',
      'HEADER-SECRET',
    ]) {
      expect(line).not.toContain(secret);
    }
  });

  it('logs at the level matching the status', () => {
    run({ NODE_ENV: 'development' }, base, 404);
    run({ NODE_ENV: 'development' }, base, 500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('uses dashes when there is no user or request id (e.g. a 401)', () => {
    run({ NODE_ENV: 'development' }, { method: 'GET', originalUrl: '/x' }, 401);
    expect(warn.mock.calls[0][0]).toContain('requestId=- userId=-');
  });

  it('is silent under test and when LOG_HTTP=false, but still calls next()', () => {
    expect(run({ NODE_ENV: 'test' }, base).next).toHaveBeenCalled();
    run({ NODE_ENV: 'development', LOG_HTTP: 'false' }, base);
    expect(log).not.toHaveBeenCalled();
  });

  it('always calls next()', () => {
    expect(run({ NODE_ENV: 'development' }, base).next).toHaveBeenCalledTimes(
      1,
    );
  });
});
