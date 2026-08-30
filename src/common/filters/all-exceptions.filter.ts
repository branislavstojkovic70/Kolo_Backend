import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'http';

interface ErrorBody {
  statusCode: number;
  message: string;
  error: string;
}

/**
 * One error shape for the whole API: { statusCode, message, error }.
 *
 * `message` is ALWAYS a single string — class-validator hands us an array, and the
 * frontend should never have to branch on that. Multiple messages are joined with "; ".
 * Nothing internal (stack traces, Prisma SQL, driver text) ever reaches the client;
 * 5xx bodies are generic and the real cause goes to the log.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const body = this.toBody(exception);

    if (body.statusCode >= 500) {
      // The only place the real cause is recorded — never sent to the client.
      this.logger.error(
        `${req.method} ${req.originalUrl} → ${body.statusCode}: ${this.describe(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${req.method} ${req.originalUrl} → ${body.statusCode}: ${body.message}`,
      );
    }

    res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        return { statusCode, message: payload, error: this.reason(statusCode) };
      }

      const p = payload as { message?: unknown; error?: unknown };
      return {
        statusCode,
        message:
          this.flatten(p.message) ||
          exception.message ||
          this.reason(statusCode),
        error: typeof p.error === 'string' ? p.error : this.reason(statusCode),
      };
    }

    const prisma = this.fromPrisma(exception);
    if (prisma) return prisma;

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Something went wrong on our side. Please try again.',
      error: this.reason(HttpStatus.INTERNAL_SERVER_ERROR),
    };
  }

  /** Prisma errors that are really the caller's fault, so the FE gets a usable status. */
  private fromPrisma(exception: unknown): ErrorBody | null {
    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'The request contained invalid data.',
        error: this.reason(HttpStatus.BAD_REQUEST),
      };
    }

    if (!(exception instanceof Prisma.PrismaClientKnownRequestError))
      return null;

    switch (exception.code) {
      case 'P2025': // record required by the operation was not found
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Not found',
          error: this.reason(HttpStatus.NOT_FOUND),
        };
      case 'P2002': // unique constraint
        return {
          statusCode: HttpStatus.CONFLICT,
          message: 'That already exists.',
          error: this.reason(HttpStatus.CONFLICT),
        };
      case 'P2003': // foreign key constraint
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'That reference does not exist.',
          error: this.reason(HttpStatus.BAD_REQUEST),
        };
      default:
        return null; // falls through to the generic 500 above
    }
  }

  /** class-validator gives string[]; everything else gives a string. */
  private flatten(message: unknown): string {
    if (Array.isArray(message)) return message.map((m) => String(m)).join('; ');
    if (typeof message === 'string') return message;
    return '';
  }

  private reason(statusCode: number): string {
    return STATUS_CODES[statusCode] ?? 'Error';
  }

  private describe(exception: unknown): string {
    if (exception instanceof Error)
      return `${exception.name}: ${exception.message}`;
    return String(exception);
  }
}
