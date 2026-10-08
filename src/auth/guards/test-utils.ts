import { ExecutionContext } from '@nestjs/common';

export const makeContext = (
  req: Record<string, unknown> = {},
): ExecutionContext =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;
