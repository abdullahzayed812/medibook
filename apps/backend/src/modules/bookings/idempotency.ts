import { createHash } from 'node:crypto';
import type { Database, SqlExecutor } from '../../infrastructure/database/database.js';
import { AppError } from '../../shared/errors/app-error.js';

/**
 * Idempotency for critical writes (ADR-046). The key row is INSERTED as the first statement of
 * the business transaction:
 *  - a concurrent request with the same key blocks on the unique index until the first one
 *    commits, then sees the stored response (replay) — never a second execution;
 *  - if the business transaction fails, the key row rolls back with it, so a retry runs again;
 *  - the same key with a different payload is `409 IDEMPOTENCY_KEY_REUSED`.
 * Scope = actor (user id or guest session) + operation, so keys never collide across actors.
 */
export interface IdempotencyContext {
  readonly scope: string;
  readonly operation: string;
  readonly key: string;
  readonly payload: unknown;
}

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export class IdempotentReplay extends Error {
  constructor(readonly response: StoredResponse) {
    super('idempotent replay');
  }
}

export function requestHash(payload: unknown): string {
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

/**
 * Claims the key inside `tx`. Throws IdempotentReplay (with the stored response) when the key
 * was already completed with the same payload.
 */
export async function claimIdempotencyKey(
  tx: SqlExecutor,
  ctx: IdempotencyContext,
): Promise<{ complete(status: number, body: unknown): Promise<void> }> {
  const hash = requestHash(ctx.payload);
  const existing = await tx.query<{
    id: string;
    request_hash: string;
    response_status: number | null;
    response_body: unknown;
    expired_at: Date | null;
  }>(
    `SELECT id, request_hash, response_status, response_body, expired_at FROM idempotency_keys
      WHERE scope_key = ? AND operation = ? AND idem_key = ? FOR UPDATE`,
    [ctx.scope, ctx.operation, ctx.key],
  );
  const row = existing[0];
  // Past the replay window the response is gone but the tombstone stays: refuse, never re-run.
  if (row !== undefined && row.expired_at !== null)
    throw new AppError(
      409,
      'IDEMPOTENCY_KEY_EXPIRED',
      'This Idempotency-Key has expired; use a new key for a new request',
    );
  if (row !== undefined) {
    if (row.request_hash !== hash)
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request',
      );
    if (row.response_status !== null)
      throw new IdempotentReplay({ status: row.response_status, body: row.response_body });
  }
  // INSERT (or, for a row left without response — impossible with same-transaction writes,
  // kept defensive) take the lock. A concurrent same-key INSERT waits here.
  let id = row?.id;
  if (id === undefined) {
    try {
      id = String(
        (
          await tx.execute(
            'INSERT INTO idempotency_keys (scope_key, operation, idem_key, request_hash) VALUES (?, ?, ?, ?)',
            [ctx.scope, ctx.operation, ctx.key, hash],
          )
        ).insertId,
      );
    } catch (err) {
      // A concurrent request with the same key committed first: re-run to replay its result.
      if (isDuplicateKey(err)) throw new IdempotencyRace();
      throw err;
    }
  }
  const rowId = id;
  return {
    complete: async (status, body) => {
      await tx.execute(
        'UPDATE idempotency_keys SET response_status = ?, response_body = ? WHERE id = ?',
        [status, JSON.stringify(body), rowId],
      );
    },
  };
}

/** The key was claimed concurrently; the caller runs the operation again (it will replay). */
export class IdempotencyRace extends Error {
  constructor() {
    super('idempotency race');
  }
}

/** True for MySQL duplicate-key errors (a concurrent request claimed the key first). */
export function isDuplicateKey(err: unknown): boolean {
  return (err as { errno?: number }).errno === 1062;
}

/** Responses are replayable for this many days; afterwards only a tombstone remains (ADR-053). */
export const IDEMPOTENCY_REPLAY_DAYS = 7;

/**
 * Retention: drops stored responses older than the replay window and marks the rows expired.
 * Rows are NEVER deleted here, so an old key can never execute its operation a second time.
 * Idempotent and batched; safe to run concurrently or repeatedly.
 */
export async function expireIdempotencyKeys(
  db: Database,
  now: Date,
  batch = 1000,
): Promise<number> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_REPLAY_DAYS * 86_400_000);
  const result = await db.execute(
    'UPDATE idempotency_keys SET response_body = NULL, expired_at = ? WHERE created_at < ? AND expired_at IS NULL LIMIT ?',
    [now, cutoff, batch],
  );
  return result.affectedRows;
}
