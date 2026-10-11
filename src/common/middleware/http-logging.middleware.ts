import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import { redact } from '../security/mask';

const MAX_LOGGED_BODY_CHARS = 2000;

// On top of the secrets redact() always removes: contact details are PII.
const PII_KEYS = ['email', 'phone'];

/**
 * One access-log line per request: method, path, status, duration, request id
 * and user id. It is a middleware (not an interceptor) so that requests
 * rejected by guards (401/403) and unmatched routes (404) are logged too.
 *
 * Safety rules:
 *   - the query string is never logged (it can carry tokens);
 *   - request bodies are not logged unless LOG_HTTP_BODIES=true, and then only
 *     after `redact()` removes passwords, tokens, auth headers, tax ids and
 *     contact details (email, phone);
 *   - request/response headers are never logged;
 *   - response bodies are never logged.
 */
@Injectable()
export class HttpLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');
  private readonly enabled: boolean;
  private readonly logBodies: boolean;

  constructor(config: ConfigService) {
    const isTest = config.get('NODE_ENV') === 'test';
    this.enabled =
      config.get('LOG_HTTP', isTest ? 'false' : 'true') !== 'false';
    this.logBodies = config.get('LOG_HTTP_BODIES', 'false') === 'true';
  }

  use(req: Request, res: Response, next: NextFunction) {
    if (!this.enabled) {
      return next();
    }
    const startedAt = Date.now();

    // 'finish' reports the final status, including ones set by guards and the
    // exception filter.
    res.once('finish', () => {
      const status = res.statusCode;
      const parts = [
        `${req.method} ${req.originalUrl.split('?')[0]}`,
        String(status),
        `${Date.now() - startedAt}ms`,
        `requestId=${req.requestId ?? '-'}`,
        `userId=${(req as Request & { user?: { id: string } }).user?.id ?? '-'}`,
      ];
      if (this.logBodies && req.body && Object.keys(req.body).length > 0) {
        parts.push(
          `body=${JSON.stringify(redact(req.body, PII_KEYS)).slice(0, MAX_LOGGED_BODY_CHARS)}`,
        );
      }
      const line = parts.join(' ');
      if (status >= 500) {
        this.logger.error(line);
      } else if (status >= 400) {
        this.logger.warn(line);
      } else {
        this.logger.log(line);
      }
    });
    next();
  }
}
