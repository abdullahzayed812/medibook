import type { Container } from '../container.js';
import type { JobDefinition } from '../infrastructure/queue/queue.js';
import { expireIdempotencyKeys } from '../modules/bookings/idempotency.js';
import { NO_REQUEST_META } from '../shared/http/request-meta.js';

export const SUBSCRIPTION_LIFECYCLE_QUEUE = 'subscription-lifecycle';
export const BOOKING_EXPIRATION_QUEUE = 'booking-expiration';
export const IDEMPOTENCY_RETENTION_QUEUE = 'idempotency-retention';

/** Repeatable schedules registered by the worker at startup (idempotent upserts). */
export const JOB_SCHEDULES: readonly { queueName: string; schedulerId: string; everyMs: number }[] =
  [
    // Time-based subscription transitions (trial end, past due, grace expiry). Enforcement never
    // waits for this job (effective status is derived at request time); the sweep keeps the
    // stored status and history accurate.
    {
      queueName: SUBSCRIPTION_LIFECYCLE_QUEUE,
      schedulerId: 'subscription-lifecycle-sweep',
      everyMs: 15 * 60_000,
    },
    // Persists EXPIRED for overdue pending booking requests (and recovers any missed run).
    // Correctness never waits for it: holds stop counting at their deadline and confirmation
    // refuses overdue requests; this keeps stored status, history and events accurate.
    {
      queueName: BOOKING_EXPIRATION_QUEUE,
      schedulerId: 'booking-expiration-sweep',
      everyMs: 30_000,
    },
    // Drops idempotent replay bodies after 7 days; keeps tombstones so old keys never re-run.
    {
      queueName: IDEMPOTENCY_RETENTION_QUEUE,
      schedulerId: 'idempotency-retention',
      everyMs: 24 * 3_600_000,
    },
  ];

/** Job definitions consumed by the worker process. Processors must be idempotent. */
export function createJobDefinitions(container: Container): readonly JobDefinition[] {
  return [
    {
      queueName: SUBSCRIPTION_LIFECYCLE_QUEUE,
      processor: () =>
        container.services.subscriptions.sweep({
          ...NO_REQUEST_META,
          requestId: 'job:subscription-lifecycle',
        }),
    },
    {
      queueName: BOOKING_EXPIRATION_QUEUE,
      processor: () => container.services.bookings.expireOverdue(),
    },
    {
      queueName: IDEMPOTENCY_RETENTION_QUEUE,
      processor: () => expireIdempotencyKeys(container.db, new Date()),
    },
  ];
}
