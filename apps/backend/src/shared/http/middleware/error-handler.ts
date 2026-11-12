import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, NotFoundError, TooManyRequestsError } from '../../errors/app-error.js';
import type { ErrorResponseBody } from '../error-response.js';

interface HttpParserError {
  readonly type: string;
  readonly status: number;
}

/**
 * Errors raised by Express' body parsers (http-errors) carry a string `type`
 * discriminator (e.g. 'entity.parse.failed') and a 4xx `status`.
 */
function isBodyParserError(err: unknown): err is HttpParserError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    typeof err.type === 'string' &&
    'status' in err &&
    typeof err.status === 'number' &&
    err.status >= 400 &&
    err.status < 500
  );
}

function normalizeError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  if (isBodyParserError(err)) {
    switch (err.type) {
      case 'entity.parse.failed':
        return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
      case 'entity.too.large':
        return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
      case 'encoding.unsupported':
      case 'charset.unsupported':
        return new AppError(415, 'UNSUPPORTED_ENCODING', 'Unsupported request encoding');
      default:
        return new AppError(err.status, 'BAD_REQUEST', 'Malformed request');
    }
  }
  return undefined;
}

/** Fallback for requests that matched no route. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
};

/**
 * Centralized error handler. Must be registered last.
 *
 * - Expected errors (AppError) → their status code, code and message.
 * - Anything else → 500 with a generic message; the real error is logged with
 *   its stack but never sent to the client.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    // Too late to send a clean error body; let Express close the connection.
    next(err);
    return;
  }

  // genReqId (resolveRequestId) always produces a string.
  const requestId = typeof req.id === 'string' ? req.id : 'unknown';
  const known = normalizeError(err);

  if (known === undefined) {
    req.log.error({ err }, 'Unhandled error');
    const body: ErrorResponseBody = {
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
    };
    res.status(500).json(body);
    return;
  }

  if (known.statusCode >= 500) {
    req.log.error({ err }, known.message);
  }

  if (known instanceof TooManyRequestsError) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(known.retryAfterSeconds))));
  }

  const body: ErrorResponseBody = {
    error: {
      code: known.code,
      message: known.message,
      requestId,
      ...(known.details === undefined ? {} : { details: known.details }),
    },
  };
  res.status(known.statusCode).json(body);
};
