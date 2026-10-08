import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';
const MAX_LENGTH = 128;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

/** Reuses a sane inbound X-Request-Id, otherwise generates one. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const inbound = req.header(REQUEST_ID_HEADER);
    const id =
      inbound && inbound.length <= MAX_LENGTH && SAFE_ID.test(inbound)
        ? inbound
        : randomUUID();
    req.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  }
}
