import { z } from 'zod';

/**
 * Keyset (cursor) pagination over descending numeric ids. The cursor is opaque to clients.
 * Response shape: { data: T[], page: { limit, nextCursor } }.
 */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .regex(/^[1-9]\d{0,19}$/)
    .optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly limit: number; readonly nextCursor: string | null };
}

/** Fetch `limit + 1` rows, then call this to build the page. */
export function toPage<T extends { id: string }>(rows: readonly T[], limit: number): Page<T> {
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return { data, page: { limit, nextCursor: rows.length > limit && last ? last.id : null } };
}
