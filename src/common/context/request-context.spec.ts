import { getRequestId, runWithRequestContext } from './request-context';

describe('request context', () => {
  it('is empty outside a request', () => {
    expect(getRequestId()).toBeUndefined();
  });

  it('exposes the id to code running inside, including across awaits', async () => {
    await runWithRequestContext({ requestId: 'req-1' }, async () => {
      expect(getRequestId()).toBe('req-1');
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(getRequestId()).toBe('req-1');
      await Promise.resolve().then(() => expect(getRequestId()).toBe('req-1'));
    });
    expect(getRequestId()).toBeUndefined();
  });

  it('keeps concurrent requests apart', async () => {
    const seen: string[] = [];
    const request = (id: string, delayMs: number) =>
      runWithRequestContext({ requestId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen.push(`${id}:${getRequestId()}`);
      });

    await Promise.all([request('a', 20), request('b', 5), request('c', 10)]);

    expect(seen.sort()).toEqual(['a:a', 'b:b', 'c:c']);
  });
});
