import type { Request } from 'express';
import { z } from 'zod';

/**
 * Typed accessors for request parts ALREADY validated by the `validate` middleware on the same
 * route (deliberate typed casts; the schema is the source of truth).
 */
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
export const body = <T>(req: Request): T => req.body as T;
export const params = <T>(req: Request): T => req.params as T;
export const query = <T>(req: Request): T => req.query as unknown as T;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .regex(/^[1-9]\d{0,19}$/)
    .optional(),
});

export const reasonBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
export const optionalReasonBody = z
  .object({ reason: z.string().trim().min(3).max(1000).optional() })
  .strict();
export const noteBody = z.object({ note: z.string().trim().min(3).max(1000) }).strict();
