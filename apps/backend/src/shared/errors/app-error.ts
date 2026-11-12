/**
 * Base class for expected (operational) errors.
 *
 * Throw AppError subclasses from any layer; the centralized error handler maps
 * them to HTTP responses. Anything that is not an AppError is treated as an
 * unexpected programming/infrastructure error and returned as a generic 500.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(400, 'BAD_REQUEST', message, { details });
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = 'Request validation failed') {
    super(400, 'VALIDATION_ERROR', message, { details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(
    public readonly retryAfterSeconds: number,
    message = 'Too many requests, please try again later',
    code = 'RATE_LIMITED',
  ) {
    super(429, code, message, { details: { retryAfterSeconds } });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(code = 'SERVICE_UNAVAILABLE', message = 'Service temporarily unavailable') {
    super(503, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict', details?: unknown) {
    super(409, 'CONFLICT', message, { details });
  }
}
