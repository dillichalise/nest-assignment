import { AsyncLocalStorage } from 'async_hooks';

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Carries the current request id through async code without threading it
 * through every function signature. The audit trail reads it so each row can
 * be tied back to the HTTP request (and its log lines) that caused it.
 */
export const runWithRequestContext = <T>(
  context: RequestContext,
  fn: () => T,
): T => storage.run(context, fn);

/** undefined outside a request (workers, scripts). */
export const getRequestId = (): string | undefined =>
  storage.getStore()?.requestId;
