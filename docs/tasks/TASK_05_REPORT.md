# Task 05 report: Booking Engine

| Field  | Value                                                                           |
| ------ | ------------------------------------------------------------------------------- |
| Task   | 05: Booking Engine (slot mode; queue contract only)                             |
| Date   | 2026-11-11                                                                      |
| Status | Awaiting project-owner review                                                   |
| Next   | Owner review. **Task 06 not started; no queue sessions, check-in or UI built.** |

## 1. Implemented scope

All ten objectives are implemented for **slot** bookings:

- availability and slot generation;
- booking requests with manual confirmation and rejection;
- deadline-bound capacity holds;
- conflict prevention for doctors (global across clinics) and patients;
- rescheduling by replacement, cancellation with snapshotted policy, expiration with a worker
  sweep, and full history;
- guest booking and booking for others (dependents and consenting accounts);
- secure patient, guest and clinic APIs.

The queue integration contract is defined and refused at runtime (422) until Task 06.

**Inspection findings that shaped the design:**

- There was no existing booking, idempotency or notification code. The outbox exists and is
  used; notification consumers remain future work.
- `patient_profiles` are clinic-scoped (Task 02). They are reused, and a global non-medical
  `booking_persons` identity was added for conflicts and ownership (ADR-045).
- The PATIENT role was never granted (OD-07). It is now granted on first booking use (ADR-045,
  reported here as a decision).
- The OTP service was LOGIN-only. It now takes a purpose (`GUEST_BOOKING`).
- Task 04 schedule resolution was private to a staff `TenantContext`. It was extracted, without
  any behaviour change, into `clinic-setup/schedule-data.ts`, so bookings use **the same**
  working-time resolver (all Task 04 tests pass unchanged).
- `clinic.bookings.manage` was NEW_OPERATION, so rejecting or cancelling under restrictions
  would have been blocked. A new `clinic.bookings.cancel` (CONTINUITY_OF_CARE) keeps releases
  possible (ADR-026).
- **Two pre-existing Task 02 concurrency bugs** were found and fixed: parallel OTP requests
  (19 of 24 failed) and parallel first logins deadlocked and returned 500 (ADR-049).

## 2. Architecture and domain design

New module `apps/backend/src/modules/bookings/`:

| File                  | Role                                                                       |
| --------------------- | -------------------------------------------------------------------------- |
| `policy.ts`           | status machine, limits, cancellation rule, deadline, slot generator (pure) |
| `availability.ts`     | candidates, global busy time, slots, working-time fit                      |
| `bookings.service.ts` | create, reschedule, confirm, reject, cancel, expire, reads                 |
| `persons.service.ts`  | persons, dependents, delegations, guests, claim, PATIENT role              |
| `idempotency.ts`      | in-transaction replay records                                              |
| `settings.service.ts` | clinic booking settings                                                    |
| `queue-contract.ts`   | Task 06 boundary                                                           |
| `bookings.routes.ts`  | HTTP layer                                                                 |

Infrastructure additions:

- `Database.transaction(…, { isolation })` and `transactionWithRetry` (bounded retry on
  1213/1205);
- a purpose-aware OTP service;
- the worker job `booking-expiration-sweep` (30 s);
- container wiring.

ADRs **044–049**; OD-07 resolved; new open decisions **OD-25 – OD-29**.

## 3. Database (new forward-only migrations; none modified after being applied)

| Migration ID     | Change                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261111170001` | `otp_challenges.purpose` CHECK + `GUEST_BOOKING`                                                                                                           |
| `20261111170002` | `booking_persons` (UNIQUE phone_hash, UNIQUE user_id, kind CHECK)                                                                                          |
| `20261111170003` | `booking_delegations` (UNIQUE active delegate+person, BOOKING-only scope CHECK)                                                                            |
| `20261111170004` | `patient_profiles.person_id` + UNIQUE `(clinic_id, person_id)`                                                                                             |
| `20261111170005` | `clinic_booking_settings` (range CHECKs = platform limits)                                                                                                 |
| `20261111170006` | `guest_booking_sessions` (token hash UNIQUE)                                                                                                               |
| `20261111170007` | `bookings` (composite tenant FKs; UNIQUE doctor/person/replacement on generated active keys; indexes for doctor/person time, deadline sweep, clinic lists) |
| `20261111170008` | `booking_status_history`                                                                                                                                   |
| `20261111170009` | `idempotency_keys` (UNIQUE scope+operation+key)                                                                                                            |
| `20261111170010` | permission `clinic.bookings.cancel` + 3 grants                                                                                                             |

`170007` failed on its first run: MySQL forbids SET NULL on the base column of a stored
generated column. MySQL 8 DDL is atomic, so nothing was created and nothing was recorded. The
never-applied file was fixed (RESTRICT). Details: [BOOKINGS_SCHEMA.md](../database/BOOKINGS_SCHEMA.md).

## 4. Endpoints and permissions (26)

The full table and examples are in [BOOKINGS_API.md](../api/BOOKINGS_API.md).

- **Public:** `GET /availability`.
- **Patients (Bearer token; `patient.bookings.*`):**
  - `/me/availability`, `/me/booking-persons`, `/me/dependents`, `/me/delegates` (GET/POST),
    `/me/delegations/:id/revoke`, `/me/guest-bookings/claim`;
  - `/me/bookings` (POST requires `Idempotency-Key`; GET), `/me/bookings/:id`, `…/cancel`,
    `…/reschedule` (requires `Idempotency-Key`).
- **Guests (`X-Guest-Token`):** `/guest/verifications`, `/guest/verifications/verify`,
  `/guest/bookings` (POST with `Idempotency-Key`; GET), `/guest/bookings/:id`, `…/cancel`.
- **Clinic (`X-Clinic-Id`):**
  - `GET /clinic/bookings` (`clinic.bookings.view`, covered branches only) and
    `/clinic/bookings/:id`;
  - `…/confirm` (`clinic.bookings.manage`);
  - `…/reject` and `…/cancel` (`clinic.bookings.cancel`, reason required);
  - `GET/PUT /clinic/booking-settings` (any member / `clinic.settings.manage`).

## 5. Availability and slot rules

Slots are computed on every request; nothing about future slots is stored (ADR-044). The
inputs:

- clinic state: slot booking enabled, and the gate's NEW_OPERATION check (suspension, closure,
  subscription, inactive branch);
- eligible doctors: active doctor-service assignment, **effective** doctor assignment;
- Task 04 working time: doctor ∩ branch, breaks, closures, leave, extra periods, effective
  dates;
- duration (doctor override, else the offering) and buffer, both inside one working interval;
- the clinic interval grid;
- branch-zone conversion with the Task 04 DST rule, dropping any slot whose real length differs
  from the duration;
- lead time and horizon on the real start;
- removal of the doctor's holding bookings in **any clinic** (appointment + buffer) and, for an
  identified patient, their own bookings.

Creation recomputes inside the transaction and requires an exact match.

## 6. Status transitions

`BOOKING_LIFECYCLE`:

| From                 | To                                            |
| -------------------- | --------------------------------------------- |
| PENDING_CONFIRMATION | CONFIRMED, REJECTED, EXPIRED, CANCELLED       |
| CONFIRMED            | CANCELLED, RESCHEDULED, CHECKED_IN*, NO_SHOW* |
| CHECKED_IN*          | IN_PROGRESS*, CANCELLED                       |
| IN_PROGRESS*         | COMPLETED*                                    |
| all others           | terminal                                      |

\* Defined for Task 06 and clinical workflows; no Task 05 endpoint performs them.

Every change is a conditional UPDATE, a history row (actor kind, actor, reason, time) and an
outbox event.

## 7. Guest and delegated booking

- **Guests:** a purpose-bound OTP, then a 60-minute token (hash stored). No account is created.
  Access covers only that verified phone's person; a booking id alone is worthless. An account
  owns the same SELF person through its verified phone (implicitly on first use, or explicitly
  through `/claim`).
- **Delegation:**
  - DECLARED: dependents; GUARDIAN only for minors, otherwise a recorded authority statement;
  - CONSENT: granted by the person's own account.

  Scope is BOOKING only and never grants medical-record access. Delegations are revocable with
  immediate effect, and the actor, delegation and relationship are stored on each booking.

Details: [BOOKING_PERSONS.md](../platform/BOOKING_PERSONS.md).

## 8. Conflict strategy

- **Doctor:** keyed globally by `doctor_profile_id` across all clinics, on real UTC
  `[starts_at, block_ends_at)` of holding bookings. Checked at availability, creation and
  confirmation under a global doctor row lock. The answer is a generic `SLOT_UNAVAILABLE`: no
  other clinic's id, service, patient or time is revealed (tested).
- **Patient:** keyed by `person_id` on `[starts_at, ends_at)`, with `PATIENT_CONFLICT`.
  Non-overlapping bookings in any clinics are allowed. A dependent is a separate person.
- **Database second line:** UNIQUE `(doctor, starts_at)`, `(person, starts_at)` and
  `(original, pending replacement)` on generated active keys.

## 9. Concurrency, locks and idempotency

- READ COMMITTED with bounded deadlock retry.
- **Lock order:** idempotency key → clinic FOR SHARE → doctor(s) FOR UPDATE (ascending,
  global) → person FOR UPDATE → booking rows (ascending). Release paths lock booking rows only.
- Idempotency rows are written inside the business transaction: replay on the same payload,
  `IDEMPOTENCY_KEY_REUSED` on a different one, concurrent duplicates serialize, and failures
  leave no key. Scope is actor + operation (ADR-046).
- **Deterministic concurrency tests**, each with exactly one success:
  - six patients for the last slot;
  - the same doctor in two clinics (three time pairs);
  - the same patient in two clinics;
  - three parallel replacement requests;
  - confirm vs two sweeps (three rounds);
  - three identical idempotent creations;
  - parallel first use of a new patient.

## 10. Expiration worker and recovery

- A hold counts only while `confirmation_deadline > now`, in every conflict query, so a dead
  worker cannot extend it (tested: the slot reappears with no worker).
- Confirmation refuses overdue requests and records them as EXPIRED.
- The BullMQ scheduler `booking-expiration-sweep` (every 30 s) and lazy expiry at booking time
  persist EXPIRED through conditional, row-locked updates. They are idempotent under duplicates,
  retries and races (tested). The sweep scans MySQL, so missed runs are recovered on the next
  run.

## 11. Queue contract and exclusions

The contract is in `queue-contract.ts` and BOOKINGS.md § "Queue integration boundary".

- **Shared, unchanged:** the booking row (`mode='QUEUE'`, `queue_session_id`), persons,
  delegation, idempotency, status machine, history, events, confirmation, expiration and
  cancellation.
- **Task 06 adds:** `queue_sessions` plus the FK, and a `QueueCapacityPort` under the same lock
  order.
- **Not implemented:** queue sessions, ordering, capacity, positions, call-next, check-in,
  no-show workflows, departure, transfer, consultations, prescriptions, UI, payments,
  accounting and notification providers.

## 12. Tests executed and results

| Suite                                                                | Result                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| Unit `bookings/policy.test.ts` (new)                                 | ✅ 9 passed                                                   |
| Integration `bookings/availability.test.ts` (new)                    | ✅ 10 passed                                                  |
| Integration `bookings/creation.test.ts` (new)                        | ✅ 7 passed (3 consecutive runs after the first-use race fix) |
| Integration `bookings/lifecycle.test.ts` (new)                       | ✅ 11 passed                                                  |
| Integration `bookings/conflicts.test.ts` (new)                       | ✅ 12 passed                                                  |
| Integration `auth/otp.test.ts` (+2 regression tests)                 | ✅ passed                                                     |
| `npm test` (all unit)                                                | ✅ 24 files, **237 passed** (Task 04: 23 / 228)               |
| `npm run test:integration` (Tasks 01–05, real MySQL 8.4 + Redis 7.4) | ✅ 28 files, **271 passed** (Task 04: 24 / 229)               |
| `npm run test:bookings`                                              | ✅ 4 files, 40 passed                                         |

**Mutation checks (performed, then restored):**

- making the doctor busy query clinic-scoped failed 4 tests (cross-clinic conflicts and buffers);
- disabling confirm's deadline check failed the expiry test.

**Bugs found by these tests and fixed:**

- concurrent first-use person creation deadlocked (500);
- pre-existing OTP request and login deadlocks (500).

**Updated Task 02 contract test:** the receptionist permission list now includes
`clinic.bookings.cancel`. It is the same exact-equality assertion, not weakened.

## 13. Format, lint, typecheck, build

| Command                | Result                                             |
| ---------------------- | -------------------------------------------------- |
| `npm run format:check` | ✅                                                 |
| `npm run lint`         | ✅ (5 findings in new code fixed, none suppressed) |
| `npm run typecheck`    | ✅                                                 |
| `npm run build`        | ✅                                                 |

Migrations:

- dev: 62 applied, 0 pending; a re-run applies `count: 0`;
- dev vs test schema and catalog dump identical (1,319 lines);
- a fresh scratch database built from all 62 files has 57 tables and 81 role grants, equal to
  dev. The scratch database was dropped afterwards.

## 14. Known limitations and risks

- **No staff-created bookings** (OD-25). Staff confirm, reject, cancel and view only.
- **Guests book only for themselves** (OD-26).
- **Phone change or recycled numbers** need a support process (OD-27, `PERSON_LINK_CONFLICT`).
- **Notifications:** events are in the outbox, but no publisher or consumers exist yet (OD-29).
- **Fall-back DST slots can't be tested end to end:** the platform's 180-day horizon keeps the
  next fall-back date out of reach today. The rule is unit-tested.
- **Serialization:** one doctor's bookings serialize globally (short transactions; ADR-046
  trade-off).
- **Idempotency records** are not cleaned up yet. A retention job is future work; the
  `created_at` index exists.
- **Guest hashes:** the phone hash uses the auth secret's derived key, so rotating that secret
  would orphan guest identities.

## 15. Decisions and deviations

| Item                                             | Note                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| PATIENT role auto-grant (resolves OD-07)         | required for patient self-booking; audited                              |
| Global `booking_persons` identity                | needed for global patient conflicts without merging clinic records      |
| `clinic.bookings.cancel`                         | new permission, so releases work under ADR-026 restrictions             |
| Purpose-bound guest OTP                          | `GUEST_BOOKING`; no account created                                     |
| Booking does not require Marketplace eligibility | OD-28                                                                   |
| Pre-existing login/OTP deadlocks fixed (ADR-049) | outside the booking module, but they blocked concurrent booking clients |

## 16. Exact verification commands

```bash
npm run migrate && npm run migrate:status && npm run migrate        # 10 applied → 62/0 → count 0
npx vitest run src/modules/bookings src/modules/clinic-setup         # in apps/backend
npx vitest run --config vitest.integration.config.ts tests/integration/bookings tests/integration/auth   # in apps/backend
npm run format:check && npm run lint && npm run typecheck && npm run build
npm test
npm run test:integration
npm run test:bookings
# schema parity: information_schema dump medibook vs medibook_test → diff (identical)
# fresh build: all 62 files into a scratch schema → 57 tables, 81 grants → dropped
```
