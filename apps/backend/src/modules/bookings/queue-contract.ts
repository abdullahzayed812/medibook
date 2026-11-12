import type { SqlExecutor } from '../../infrastructure/database/database.js';
import type { BookingStatus } from './policy.js';

/**
 * Integration contract for queue-mode bookings (Task 06). NOTHING here is implemented in Task 05;
 * this file fixes the boundary so Task 06 can add queue bookings without redesigning the Booking
 * domain. See docs/platform/BOOKINGS.md § "Queue integration boundary".
 *
 * Shared with slot bookings (owned by Task 05, reused unchanged):
 *  - the `bookings` row (mode = 'QUEUE', starts_at/ends_at/block_ends_at NULL, queue_session_id
 *    set), patient person/profile resolution, delegation, guest access, idempotency;
 *  - the status machine BOOKING_LIFECYCLE, status history, audit and outbox events;
 *  - manual confirmation, rejection, expiration (confirmation_deadline), cancellation policy
 *    snapshot and the patient/clinic cancel paths.
 *
 * Owned by Task 06 (must NOT be emulated with slots):
 *  - queue sessions (table, FK bookings.queue_session_id → queue_sessions), capacity, ordering,
 *    priority, queue numbers/positions, check-in, call-next, no-show, departure, transfer;
 *  - the capacity check below, called inside the booking transaction under the same lock order
 *    (it adds a queue-session row lock between the doctor and person locks).
 */
export interface QueueCapacityPort {
  /** Lock the session and verify a place is available for one more pending/confirmed booking. */
  assertCapacity(
    tx: SqlExecutor,
    input: { clinicId: string; branchId: string; queueSessionId: string; personId: string },
  ): Promise<void>;
  /** Called after a status change so the queue can release or account the place. */
  onStatusChanged(
    tx: SqlExecutor,
    input: { bookingId: string; queueSessionId: string; from: BookingStatus; to: BookingStatus },
  ): Promise<void>;
}

/**
 * Today: `mode = QUEUE` requests are refused with 422 BOOKING_MODE_NOT_SUPPORTED, clinics cannot
 * enable queue mode (422 QUEUE_MODE_NOT_AVAILABLE), and no queue port is registered.
 */
export function isQueueModeAvailable(): boolean {
  return false;
}
