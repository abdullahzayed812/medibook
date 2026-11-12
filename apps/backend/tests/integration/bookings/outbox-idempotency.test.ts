import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expireIdempotencyKeys } from '../../../src/modules/bookings/idempotency.js';
import { createHarness } from '../support/harness.js';
import type { LoggedIn } from '../support/fixtures.js';
import { adminSession, code, data } from '../support/platform.js';
import {
  book,
  bookableClinic,
  bookSlot,
  key,
  patient,
  slotBody,
  slots,
  type BookableClinic,
} from '../support/bookings.js';

/** Task 05.1: outbox atomicity and idempotency retention. */
const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let b: BookableClinic;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  b = await bookableClinic(h, admin, { settings: { confirmationTtlMinutes: 5 } });
});

const count = async (sql: string, params: string[] = []) =>
  Number((await h.db.query<{ n: string }>(sql, params))[0]?.n ?? 0);

describe('transactional outbox', () => {
  it('a booking and its outbox event commit together', async () => {
    const id = await bookSlot(h, b, await patient(h));
    expect(
      await h.db.query(
        `SELECT event_type, clinic_id FROM domain_events WHERE aggregate_type = 'booking' AND aggregate_id = ?`,
        [id],
      ),
    ).toEqual([{ event_type: 'booking.requested', clinic_id: b.c.clinicId }]);
  });

  it('a transaction failing AFTER the booking row was written leaves no booking, history, event, key or person', async () => {
    // Force the outbox INSERT (after the booking and history inserts) to fail inside the transaction.
    await h.db.execute(
      `ALTER TABLE domain_events ADD CONSTRAINT ck_t051_reject CHECK (event_type <> 'booking.requested')`,
    );
    try {
      const p = await patient(h);
      const before = await count('SELECT COUNT(*) AS n FROM booking_persons');
      const slot = (await slots(h, b)).slots[0];
      const res = await book(
        h,
        p,
        slotBody(
          b,
          slot ??
            (() => {
              throw new Error('no slot');
            })(),
        ),
      );
      expect(res.status).toBe(500);
      expect(await count('SELECT COUNT(*) AS n FROM bookings')).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM booking_status_history')).toBe(0);
      expect(
        await count(`SELECT COUNT(*) AS n FROM domain_events WHERE aggregate_type = 'booking'`),
      ).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM idempotency_keys')).toBe(0);
      expect(
        await count(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'BOOKING_CREATED'`),
      ).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM booking_persons')).toBe(before + 1); // only the self person (own, earlier transaction)
    } finally {
      await h.db.execute('ALTER TABLE domain_events DROP CHECK ck_t051_reject');
    }
    // After the fault is gone the same request works (no stale key blocks it).
    expect(
      (await book(h, await patient(h), slotBody(b, (await slots(h, b)).slots[0] ?? ({} as never))))
        .status,
    ).toBe(201);
  });

  it('duplicate processing does not duplicate effects: concurrent sweeps emit one expiry event', async () => {
    const id = await bookSlot(h, b, await patient(h));
    h.clock.advance(5 * 60_000 + 1000);
    const runs = await Promise.all(
      [1, 2, 3].map(() => h.container.services.bookings.expireOverdue()),
    );
    expect(runs.reduce((a, n) => a + n, 0)).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM domain_events WHERE aggregate_id = ? AND event_type = 'booking.expired'`,
        [id],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM booking_status_history WHERE booking_id = ? AND to_status = 'EXPIRED'`,
        [id],
      ),
    ).toBe(1);
  });
});

describe('idempotency retention', () => {
  it('within the replay window a key replays; afterwards its tombstone refuses the request instead of re-running it', async () => {
    const p = await patient(h);
    const k = key();
    const body = slotBody(b, (await slots(h, b)).slots[0] ?? ({} as never));
    const first = await book(h, p, body, k);
    expect(first.status).toBe(201);
    expect(await expireIdempotencyKeys(h.db, h.clock())).toBe(0); // still inside the window
    expect(data<{ id: string }>(await book(h, p, body, k)).id).toBe(data<{ id: string }>(first).id);
    // Age the key past the 7-day window, run retention (twice: idempotent).
    await h.db.execute('UPDATE idempotency_keys SET created_at = created_at - INTERVAL 8 DAY');
    expect(await expireIdempotencyKeys(h.db, h.clock())).toBe(1);
    expect(await expireIdempotencyKeys(h.db, h.clock())).toBe(0);
    expect(await h.db.query('SELECT response_body FROM idempotency_keys')).toEqual([
      { response_body: null },
    ]);
    // Cancel the booking so the slot is free again: a re-execution WOULD succeed — it must not happen.
    await h.db.execute(`UPDATE bookings SET status = 'CANCELLED'`);
    expect(code(await book(h, p, body, k))).toBe('IDEMPOTENCY_KEY_EXPIRED');
    expect(await count('SELECT COUNT(*) AS n FROM bookings')).toBe(1);
  });
});
