import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { STATUS_CODES } from 'http';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { DomainError } from '../errors/domain.error';
import { ErrorResponseDto } from '../errors/error-response.dto';

const PG_UNIQUE_VIOLATION = '23505';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const { statusCode, message, details } = this.normalize(exception);

    if (statusCode >= 500) {
      // Real cause is logged, never returned to the client.
      this.logger.error(
        `[${req.requestId}] ${req.method} ${req.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorResponseDto = {
      statusCode,
      error: STATUS_CODES[statusCode] ?? 'Error',
      message,
      ...(details !== undefined && { details }),
      requestId: req.requestId ?? 'unknown',
      timestamp: new Date().toISOString(),
      path: req.url.split('?')[0],
    };
    res.status(statusCode).json(body);
  }

  private normalize(exception: unknown): {
    statusCode: number;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof DomainError) {
      return {
        statusCode: exception.status,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'string') {
        return { statusCode, message: response };
      }
      const { message, details } = response as {
        message?: string | string[];
        details?: unknown;
      };
      return Array.isArray(message)
        ? { statusCode, message: 'Request failed', details: message }
        : { statusCode, message: message ?? exception.message, details };
    }

    if (
      exception instanceof QueryFailedError &&
      (exception.driverError as { code?: string })?.code === PG_UNIQUE_VIOLATION
    ) {
      return {
        statusCode: HttpStatus.CONFLICT,
        message: 'Resource already exists',
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }
}
