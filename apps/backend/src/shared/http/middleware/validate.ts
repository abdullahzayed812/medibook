import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { ValidationError } from '../../errors/app-error.js';

export interface RequestSchemas {
  readonly body?: ZodType;
  readonly query?: ZodType;
  readonly params?: ZodType;
}

export interface ValidationIssue {
  readonly location: 'body' | 'query' | 'params';
  readonly path: string;
  readonly message: string;
}

/**
 * Validates and normalizes request input against zod schemas before the
 * controller runs. On success the parsed (coerced, stripped) values replace
 * the raw ones, so controllers only ever see validated data. On failure a
 * ValidationError (400) is forwarded to the centralized error handler.
 *
 * Usage: router.post('/x', validate({ body: schema }), controller.create)
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    const issues: ValidationIssue[] = [];
    const parsed: Partial<Record<keyof RequestSchemas, unknown>> = {};

    for (const location of ['params', 'query', 'body'] as const) {
      const schema = schemas[location];
      if (schema === undefined) continue;
      const result = schema.safeParse(req[location]);
      if (result.success) {
        parsed[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ location, path: issue.path.join('.'), message: issue.message });
        }
      }
    }

    if (issues.length > 0) {
      next(new ValidationError(issues));
      return;
    }

    if ('body' in parsed) req.body = parsed.body;
    if ('params' in parsed) req.params = parsed.params as typeof req.params;
    if ('query' in parsed) {
      // Express 5 exposes `req.query` as a getter; redefine it to hold the parsed value.
      Object.defineProperty(req, 'query', {
        value: parsed.query,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    next();
  };
}
