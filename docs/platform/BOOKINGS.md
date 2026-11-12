# Booking Engine

> **Purpose:** the booking domain: how appointments are requested, held, confirmed, rejected,
> expired, cancelled and rescheduled; how availability is calculated; how conflicts, concurrency
> and idempotency are handled; and where queue bookings (Task 06) plug in. Decisions:
> ADR-044 – ADR-049. Related: [BOOKING_PERSONS.md](BOOKING_PERSONS.md) (patients, guests,
> delegation) · [SCHEDULES.md](SCHEDULES.md) (working time) ·
> [BOOKINGS_API.md](../api/BOOKINGS_API.md) · [BOOKINGS_SCHEMA.md](../database/BOOKINGS_SCHEMA.md).

## Model

One `bookings` row per booking. It belongs to a clinic and a branch, and it references:

- the clinic patient profile (`patient_profile_id`);
- the global booking person (`person_id`: who the appointment is for; its `identity_id` is the
  patient conflict key, see [BOOKING_PERSONS.md § Canonical booking identity](BOOKING_PERSONS.md#canonical-booking-identity));
- the global doctor profile (`doctor_profile_id`, the doctor conflict key);
- the Task 04 doctor assignment, branch offering and service.

**Modes:** `SLOT` is implemented. `QUEUE` is reserved for Task 06 (see below).

**Snapshots** taken at creation make a booking meaningful forever, even if the service is
renamed, repriced or deactivated, or the doctor leaves:

| Snapshot        | Columns                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| doctor, service | `doctor_display_name`, `service_name_en/ar`                                                                                    |
| money           | `price_minor` + `currency` (doctor override, else the offering; integer minor units, default EGP)                              |
| time            | `starts_at`, `ends_at` (UTC), `block_ends_at` (= end + buffer), `time_zone`                                                    |
| policy          | `cancellation_policy` (JSON), `booking_rules` (interval, lead, horizon, TTL)                                                   |
| actor           | `actor_kind` (SELF/DELEGATE/GUEST), `actor_user_id`, `delegation_id`, `relationship`, `guest_session_id`, `contact_phone_e164` |

No payment is collected. Price and currency are informational.

## Lifecycle

```
                 confirm (clinic)                    reschedule accepted
PENDING_CONFIRMATION ───────────▶ CONFIRMED ─────────────────────────────▶ RESCHEDULED
   │ reject (clinic, reason)        │ cancel (patient within policy / clinic with reason)
   │ deadline passed                ▼
   │ cancel (patient: always)     CANCELLED          CONFIRMED → CHECKED_IN → IN_PROGRESS → COMPLETED
   ▼                                                 CONFIRMED → NO_SHOW          (Task 06 / clinical)
REJECTED · EXPIRED · CANCELLED
```

`BOOKING_LIFECYCLE` (in `policy.ts`) is the only definition of allowed transitions. Every change
goes through one method that does three things:

- a **conditional** `UPDATE … WHERE status = <expected>`;
- an append-only `booking_status_history` row (from, to, actor kind, actor, reason, time);
- an outbox event.

Task 05 performs these transitions:

- PENDING → CONFIRMED / REJECTED / EXPIRED / CANCELLED;
- CONFIRMED → CANCELLED / RESCHEDULED.

The other transitions are defined, but no Task 05 endpoint performs them.

## Capacity holds and expiration

- A request is created as `PENDING_CONFIRMATION` with
  `confirmation_deadline = min(now + TTL, starts_at)`. It **holds** its time (doctor and
  patient) only while `confirmation_deadline > now`. That condition is part of every conflict
  query (`HOLDS_TIME_SQL`), so an overdue hold stops counting at its deadline, even if no worker
  ever runs.
- **Confirmation refuses** an overdue request and records it as EXPIRED in the same
  transaction (`409 BOOKING_EXPIRED`). It never relies on the worker having run.
- **Persisted expiration** keeps the stored status, history and events accurate:
  - the worker's BullMQ scheduler `booking-expiration-sweep` runs every **30 s**;
  - booking creation lazily expires any overdue holds of the same doctor or patient.

  The sweep is the reconciliation: it scans MySQL (`status = PENDING AND deadline ≤ now`,
  indexed), so missed, delayed, duplicated or retried runs all converge. Each expiry is a
  conditional update under the booking row lock. Duplicate sweeps and a racing confirmation
  therefore yield **exactly one** outcome (tested with parallel confirm + two sweeps).

- Rejection, cancellation and expiry release the time simply by leaving the holding statuses.
  Confirmation turns the hold into an occupying booking.

## Manual confirmation

`POST /clinic/bookings/:id/confirm` needs `clinic.bookings.manage` (NEW_OPERATION) for the
booking's branch. Inside one transaction, under the locks below, it re-validates:

- the booking is still PENDING and its deadline has not passed;
- the doctor assignment is still effective (membership, coverage, verification, branch active),
  and the doctor still holds the service;
- the offering and service are active;
- `[starts_at, block_ends_at)` still lies inside the doctor's resolved working time (schedule
  changes, closures and leave are honoured);
- there is no doctor conflict (all clinics) and no patient conflict, ignoring the booking itself
  and, for a replacement, its original;
- the operation gate allows it: suspensions, closure, a restricted subscription or an inactive
  branch block confirmation.

Errors: `BOOKING_EXPIRED`, `INVALID_TRANSITION`, `BOOKING_NOT_CONFIRMABLE`,
`SLOT_UNAVAILABLE`, `PATIENT_CONFLICT`, and the gate codes.

`reject` needs `clinic.bookings.cancel` (CONTINUITY_OF_CARE) and a reason.

## Cancellation

- The policy is **snapshotted** per booking (`minNoticeMinutes`, `reasonRequired`). A later
  settings change never affects existing bookings (tested).
- **Patient (or delegate, or guest):** a pending request can always be withdrawn. A confirmed
  booking can be cancelled until `starts_at − minNoticeMinutes`
  (`409 CANCELLATION_NOT_ALLOWED` with `cancelUntil`), with a reason when the policy requires
  one (`400 CANCELLATION_REASON_REQUIRED`). Patient cancellation is not blocked by clinic
  restrictions.
- **Clinic:** `clinic.bookings.cancel` plus a reason. This is allowed during a NEW_OPERATIONS
  suspension or a restricted subscription (continuity of care, ADR-026).
- Cancelling an original with a pending replacement also cancels the replacement.

## Rescheduling

1. `POST /me/bookings/:id/reschedule { startsAt, assignmentId? }` on a **CONFIRMED** booking
   creates a **replacement** PENDING request (`reschedule_of_booking_id`). It keeps the same
   clinic, branch and service; the doctor may change.
2. The original stays CONFIRMED and keeps its time. The replacement holds its own new time.
   Conflict checks ignore the original, so moving within an overlapping period works.
3. At most **one** pending replacement per original (unique key plus check; a parallel race
   produces exactly one, tested).
4. Confirming the replacement re-validates everything. In the same transaction it then sets
   the replacement to CONFIRMED and the original to `RESCHEDULED` (`superseded_by_booking_id`).
5. A rejected or expired replacement, or a failed confirmation (for example the slot became
   invalid), leaves the original **unchanged**. A patient is never left without a booking.

## Availability and slot calculation

`GET /availability` (public) and `GET /me/availability` (also hides the patient's own busy
times) return **bookable slots only**: doctor display name, assignment id, start/end (UTC and
local), duration and price. Nothing about other bookings, patients or clinics is returned.
Ranges are limited to 14 days and 2,000 slots.

Nothing about future slots is persisted or cached. Slots are computed per request from:

1. **Clinic state.** Slot booking must be enabled. The operation gate's NEW_OPERATION check
   covers suspension, closure, the subscription and an inactive branch. Patients only see the
   generic reason `NOT_ACCEPTING_BOOKINGS`.
2. **Eligible doctors.** An active doctor-service assignment for the branch offering (service
   and offering active) and an **effective** doctor branch assignment (Task 04 blockers).
3. **Working time.** Task 04's resolved working time: doctor ∩ branch, breaks, date
   exceptions, leave, extra periods, effective dates.
4. **Duration and buffer.** The duration is the doctor override, else the offering duration.
   The buffer is the offering's. The appointment **and** its buffer must fit inside one working
   interval, so a slot never crosses a break, closure or leave.
5. **Grid.** Candidate starts step by the clinic's `slotIntervalMinutes` from each working
   interval's start.
6. **Time zones.** Conversion uses the branch IANA zone with the Task 04 DST rule. A slot whose
   real UTC length is not exactly the duration (it touches a DST gap or overlap) is **not
   offered**.
7. **Lead time and horizon.** Applied to the real start instant (`minLeadMinutes`,
   `maxHorizonDays`).
8. **Conflicts.** The doctor's holding bookings in **any clinic**, compared with appointment +
   buffer. For an identified patient, also their own holding bookings, compared with the
   appointment.

Booking creation recomputes the same slots **inside its transaction** and requires an exact
match of the requested start. A client's earlier availability answer is never trusted; stale
data gets `409 SLOT_UNAVAILABLE`.

## Conflicts

| Conflict      | Key                                                             | Compared                                                  | Where                                                    |
| ------------- | --------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| **Doctor**    | `doctor_profile_id`: **global**, every clinic                   | real UTC `[starts_at, block_ends_at)` of holding bookings | availability, creation, confirmation                     |
| **Patient**   | `identity_id`: canonical booking identity (every linked person) | real UTC `[starts_at, ends_at)`                           | creation, confirmation, rescheduling, `/me/availability` |
| **Duplicate** | same patient, doctor and start                                  | covered by both rules                                     | —                                                        |

- A doctor conflict answers only `409 SLOT_UNAVAILABLE`, the same message as "taken here". No
  other clinic's id, service, patient or time is revealed (tested).
- Recurring **schedules** are still not conflict-checked across clinics (Task 04, OD-21). Only
  actual bookings are.
- Different patients, or the same patient at non-overlapping times, in any clinics, are always
  allowed.
- A dependent is a different person from the parent who books for them.
- **Canonical identity (ADR-055).** Person records linked by a claim code or an audited support
  decision share one `identity_id`. A booking for any of them conflicts with holding bookings of
  all of them, in every clinic (pending holds included). Phone equality never links.
- **Overlaps that existed before a link (ADR-056)** are recorded in `identity_link_conflicts`
  and audited. Neither booking is cancelled or moved. Confirming either one fails with
  `PATIENT_CONFLICT` until the other stops holding time.
- **Database second line:**
  - UNIQUE `(doctor_profile_id, starts_at, active_key)`;
  - UNIQUE `(person_id, starts_at, active_key)` (per person record; the cross-person identity
    rule is enforced under the identity lock);
  - UNIQUE `(reschedule_of_booking_id, replacement_key)`.

  These generated keys are set only for holding statuses. A duplicate-key error maps to
  `409 SLOT_UNAVAILABLE`.

## Concurrency, transactions and idempotency

Every booking write is one MySQL transaction at **READ COMMITTED**. Once the locks are held,
each statement sees the latest committed data. MySQL deadlock victims (1213) and lock-wait
timeouts (1205) are **retried** (bounded: 3 attempts with jitter, whole transaction).

**Lock order** (never violated):

| Step | Lock                                          | Why                                                                                                |
| ---- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1    | idempotency key row                           | per actor; first statement                                                                         |
| 2    | clinic row `FOR SHARE`                        | blocks concurrent clinic-setup writes, which take it `FOR UPDATE`; bookings don't block each other |
| 3    | doctor profile row(s) `FOR UPDATE`, ascending | serializes one doctor **across all clinics**                                                       |
| 4    | booking identity row `FOR UPDATE`             | serializes one human (all linked persons) across all clinics; links lock both identities ascending |
| 5    | booking person row `FOR UPDATE`               | re-read after step 4; if the person moved identity meanwhile, step 4 is retaken (≤ 3, then `409`)  |
| 6    | booking rows `FOR UPDATE`, ascending          |                                                                                                    |

Reject, cancel and expire only release time, so they lock only step 6 and cannot form a cycle.
A claim or support link takes no doctor lock: code row → both identities (ascending) → person
rows. It never waits on a booking lock while holding an identity lock out of order.

Tested races, each with exactly one success:

- six patients for one slot;
- one doctor in two clinics;
- one patient in two clinics;
- three replacement requests;
- confirmation vs two sweeps;
- three identical idempotent requests;
- six bookings for two linked persons at one time in three clinics (Task 05.2);
- a claim racing a booking: either the booking is refused, or the link records the overlap
  (Task 05.2).

**Idempotency** (`idempotency_keys`): the `Idempotency-Key` header is **required** for creating
and rescheduling bookings, and optional for confirm. Keys are scoped by actor (`user:<id>` or
`guest:<phone hash>`) and operation.

- The key row is written **inside** the business transaction, so a failed request leaves no
  key behind.
- A concurrent duplicate waits on the unique index and then replays the stored response.
- The same key with a different payload gets `409 IDEMPOTENCY_KEY_REUSED`.
- Only successful responses are stored. A failed attempt can be retried with the same key.
- **Retention (ADR-053).** Responses replay for **7 days**. The daily `idempotency-retention`
  job then drops the stored response and sets `expired_at`, but **keeps the key row as a
  tombstone**. A late retry with that key gets `409 IDEMPOTENCY_KEY_EXPIRED`; it is never run
  again (tested: even when the slot is free again). Rows are never deleted by the application.
  Clients must use a new key for a new request.
- Secrets are never stored in replays: a guest's one-time claim code is added to the response
  after the idempotent transaction.

## Authorization and operating policy

| Operation                   | Rule                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Availability                | public; the gate decides whether slots exist                                                                       |
| Patient create / reschedule | `patient.bookings.manage_own` (PATIENT role granted on first use, ADR-045) + gate NEW_OPERATION for the branch     |
| Patient view / cancel       | own person or active delegation; otherwise 404                                                                     |
| Guest                       | verified guest token; the session's own guest person only (created or attached with its claim code); otherwise 404 |
| Staff create                | `clinic.bookings.manage` (NEW_OPERATION) for the booking's branch                                                  |
| Clinic view / list          | `clinic.bookings.view` (READ, branch); branch-assigned staff see covered branches only                             |
| Confirm                     | `clinic.bookings.manage` (NEW_OPERATION, branch)                                                                   |
| Reject, clinic cancel       | `clinic.bookings.cancel` (CONTINUITY_OF_CARE, branch)                                                              |
| Booking settings            | read: any member; write: `clinic.settings.manage`                                                                  |

New bookings and confirmations are **new operations** (ADR-026). They are blocked by FULL and
NEW_OPERATIONS suspensions, CLOSING/CLOSED, a restricted subscription (including a zero-trial
clinic after grace, ADR-038) and an inactive branch. Releasing capacity is not: reject and
clinic cancel are continuity of care, and patient cancel is always allowed. Under a FULL
suspension, clinic-side reads and rejects need a continuity-of-care exception; pending requests
then simply expire.

## Staff-created bookings

`POST /clinic/bookings` (`X-Clinic-Id`, **`Idempotency-Key`** required) lets authorized clinic
staff book on behalf of a patient. It needs `clinic.bookings.manage` for the target branch:
receptionists, owners and managers; not doctors. Branch-assigned staff are limited to their
branches (an uncovered branch is 404).

- **Same engine.** It reuses the same `create()` path as patient bookings: lock order,
  in-transaction slot recomputation, doctor (global) and patient conflicts, operation gate,
  lead time and horizon, confirmation deadline, snapshots and idempotency. The result is a
  **PENDING_CONFIRMATION** request. Staff never pre-confirm; confirming is a separate
  `…/confirm` call.
- **Beneficiary.** One of:
  - `{ patientProfileId }`: an existing patient **of this clinic** (another clinic's profile is
    404). A legacy profile without a person gets a clinic-recorded person linked to that
    profile only.
  - `{ new: { displayName, birthDate?, contactPhone? } }`: a new **CLINIC** person, created
    inside the booking transaction, so it rolls back with a failed booking. It is **never
    matched to an account or guest by phone**; the phone is stored only as the booking's
    contact.
- **Attribution.** The actor is recorded separately: `actor_kind = STAFF`, `actor_user_id` =
  staff user, history actor STAFF. The beneficiary is `person_id` / `patient_profile_id`. No
  delegation is created and no medical-record access is granted. Staff cannot use patients'
  delegations (there is no `personId` input).

## Events

These outbox events (`domain_events`) are written in the booking transaction:

- `booking.requested`, `booking.confirmed`, `booking.rejected`, `booking.expired`,
  `booking.cancelled`;
- `booking.reschedule_requested`, `booking.rescheduled` (replacement accepted),
  `booking.superseded` (original), `booking.reschedule_rejected`,
  `booking.reschedule_expired`.

Payloads carry ids, statuses, times and the person id only: no names, services, notes, reasons,
prices or medical details.

**Guarantees (verified in Task 05.1):**

- Every status change and its event are inserted by the same transaction. A transaction
  failing after the booking row was written leaves **no** booking, history, event, audit row,
  idempotency key or new person (tested by forcing the outbox insert to fail).
- A failed delivery can never roll back a booking, because delivery happens after commit.
- Duplicate or concurrent processing (sweeps) emits one event per transition (tested: 3
  concurrent sweeps produce 1 `booking.expired`).

**Publisher responsibilities** (future work, OD-29):

- Poll `domain_events` in id order, publish at least once, and mark events published only
  after the broker or provider accepted them.
- Retry with backoff and never delete unpublished events.

**Consumer responsibilities:**

- De-duplicate by `domain_events.id` (at-least-once delivery).
- Re-read current state for anything beyond ids, because events are minimal.
- Tolerate out-of-order delivery across aggregates.
- Never put medical details in external notifications.
- Respect opt-outs.

## Clinic booking settings

`GET/PUT /clinic/booking-settings`. Platform limits are enforced by the API schema and DB
CHECKs:

| Setting                  | Range    | Default                                  |
| ------------------------ | -------- | ---------------------------------------- |
| `slotEnabled`            | —        | `true`                                   |
| `queueEnabled`           | —        | `false`; `true` is refused until Task 06 |
| `slotIntervalMinutes`    | 5–120    | 15                                       |
| `minLeadMinutes`         | 0–10,080 | 60                                       |
| `maxHorizonDays`         | 1–180    | 60                                       |
| `confirmationTtlMinutes` | 5–2,880  | 120                                      |
| `cancelMinNoticeMinutes` | 0–10,080 | 1,440                                    |
| `cancelReasonRequired`   | —        | `false`                                  |

Changes apply to new bookings only.

## Queue integration boundary (Task 06)

`queue-contract.ts` fixes the contract.

**Shared, unchanged:**

- the `bookings` row (`mode = 'QUEUE'`, `queue_session_id`, slot times NULL; the slot-times
  CHECK applies only to SLOT);
- persons, delegation, guests, idempotency;
- the status machine, history, events, confirmation, rejection, expiration and cancellation
  policy.

**Task 06 adds:**

- the `queue_sessions` table and the FK from `bookings.queue_session_id`;
- a `QueueCapacityPort` (`assertCapacity` under a session row lock between the doctor and
  person locks, and `onStatusChanged`);
- queue ordering, numbers, check-in, call-next, no-show, departure and transfer.

**Today:**

- `mode=QUEUE` availability requests get `422 BOOKING_MODE_NOT_SUPPORTED`;
- `queueEnabled: true` gets `422 QUEUE_MODE_NOT_AVAILABLE`;
- a queue booking is never treated as a slot.
