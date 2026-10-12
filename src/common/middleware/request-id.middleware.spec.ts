import { getRequestId } from '../context/request-context';
import {
  RequestIdMiddleware,
  REQUEST_ID_HEADER,
} from './request-id.middleware';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const run = (inbound?: string) => {
  const req = {
    header: jest.fn().mockReturnValue(inbound),
  } as unknown as Parameters<RequestIdMiddleware['use']>[0];
  const res = { setHeader: jest.fn() };
  let idSeenDownstream: string | undefined;
  const next = jest.fn(() => {
    idSeenDownstream = getRequestId();
  });

  new RequestIdMiddleware().use(req, res as never, next);

  return { req, res, next, idSeenDownstream };
};

describe('RequestIdMiddleware', () => {
  it('reuses a well-formed inbound request id', () => {
    const { req, res } = run('trace-abc.123_X');
    expect(req.requestId).toBe('trace-abc.123_X');
    expect(res.setHeader).toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      'trace-abc.123_X',
    );
  });

  it('generates a UUID when none is sent', () => {
    const { req, res } = run(undefined);
    expect(req.requestId).toMatch(UUID);
    expect(res.setHeader).toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      req.requestId,
    );
  });

  it('generates a different id for every request', () => {
    const ids = new Set(Array.from({ length: 50 }, () => run().req.requestId));
    expect(ids.size).toBe(50);
  });

  describe('refuses to echo anything unsafe back into a response header or log line', () => {
    it.each([
      ['an empty value', ''],
      ['spaces', 'has spaces'],
      ['a header-injection attempt (CRLF)', 'abc\r\nSet-Cookie: session=evil'],
      ['a newline', 'abc\ndef'],
      ['markup', '<script>alert(1)</script>'],
      ['quotes and semicolons', `a';DROP TABLE x;--`],
      ['non-ASCII', 'idé-日本'],
      ['a path', '../../etc/passwd'],
      ['129 characters (one too many)', 'a'.repeat(129)],
    ])('replaces %s with a generated id', (_name, hostile) => {
      const { req, res } = run(hostile);

      expect(req.requestId).toMatch(UUID);
      expect(req.requestId).not.toBe(hostile);
      expect(res.setHeader).toHaveBeenCalledTimes(1);
      expect(res.setHeader).not.toHaveBeenCalledWith(
        REQUEST_ID_HEADER,
        hostile,
      );
    });

    it('still accepts exactly 128 characters and the allowed punctuation . _ -', () => {
      expect(run('a'.repeat(128)).req.requestId).toBe('a'.repeat(128));
      expect(run('a.b_c-d').req.requestId).toBe('a.b_c-d');
    });
  });

  it('runs the rest of the request inside a context that exposes the id', () => {
    const { idSeenDownstream, req } = run('ctx-id-1');
    expect(idSeenDownstream).toBe('ctx-id-1');
    expect(idSeenDownstream).toBe(req.requestId);
    expect(getRequestId()).toBeUndefined(); // and the context does not leak outside
  });

  it('calls next() exactly once', () => {
    expect(run('x').next).toHaveBeenCalledTimes(1);
    expect(run().next).toHaveBeenCalledTimes(1);
  });
});
