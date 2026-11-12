# Booking schema (Task 05)

> **Purpose:** table-by-table reference for the Booking Engine (Tasks 05, 05.1 and 05.2). Migrations
> `20261111170001`–`20261111170010` are new, forward-only files. One existing table is extended
> additively (`patient_profiles.person_id`), and one CHECK is widened (`otp_challenges.purpose`).
> Conventions as in [CLINIC_SETUP_SCHEMA.md](CLINIC_SETUP_SCHEMA.md). Related:
> [BOOKINGS.md](../platform/BOOKINGS.md).

| Migration | Change                                                   | Key constraints and indexes                                                                                                           |
| --------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 170001    | `otp_challenges.purpose` CHECK adds `GUEST_BOOKING`      | verification is purpose-bound in code                                                                                                 |
| 170002    | `booking_persons`                                        | UNIQUE `phone_hash`; UNIQUE `user_id`; kind CHECK (SELF ⇒ phone hash; DEPENDENT ⇒ no phone and no user)                               |
| 170003    | `booking_delegations`                                    | UNIQUE active `(delegate_user_id, person_id, active_key)`; relationship/basis CHECKs; `scope = 'BOOKING'` CHECK; status/revoked CHECK |
| 170004    | `patient_profiles.person_id` (nullable)                  | UNIQUE `(clinic_id, person_id)`; FK `booking_persons`                                                                                 |
| 170005    | `clinic_booking_settings`                                | PK `clinic_id`; range CHECKs = platform limits                                                                                        |
| 170006    | `guest_booking_sessions`                                 | UNIQUE `token_hash` (SHA-256 only); ix `(phone_hash, expires_at)`                                                                     |
| 170007    | `bookings`                                               | see below                                                                                                                             |
| 170008    | `booking_status_history`                                 | FK `(clinic_id, booking_id)`; ix `(clinic_id, booking_id, id)`; append-only                                                           |
| 170009    | `idempotency_keys`                                       | UNIQUE `(scope_key, operation, idem_key)`; ix `created_at`                                                                            |
| 170010    | permission `clinic.bookings.cancel` (CONTINUITY_OF_CARE) | granted to owner, manager, receptionist                                                                                               |

### Task 05.1 migrations

| Migration | Change                                                                                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 180001    | `otp_challenges.purpose` CHECK adds `PHONE_CHANGE`                                                                                                                                                                                                                         |
| 180002    | `booking_persons`: phone hash **no longer unique** (index only), `phone_hash_key_version`, `claimed_by_user_id` + `claimed_at` (FK RESTRICT), kind CHECK (SELF ⇒ user; GUEST ⇒ phone hash, no user; DEPENDENT/CLINIC ⇒ neither); account-less SELF rows converted to GUEST |
| 180003    | `guest_claim_codes`: UNIQUE `code_hash` (SHA-256), status CHECK (ACTIVE/USED/REVOKED with timestamps), ix `(person_id, status)`                                                                                                                                            |
| 180004    | `guest_booking_sessions.person_id` (bound person), `failed_attach_count`, `phone_hash_key_version`                                                                                                                                                                         |
| 180005    | `identity_support_cases`: status CHECK (OPEN/LINKED/REJECTED), ix `(status, id)`, `(requested_by_user_id, id)`                                                                                                                                                             |
| 180006    | `idempotency_keys.expired_at` + index (tombstones)                                                                                                                                                                                                                         |
| 180007    | permission `platform.identity.resolve` → SUPER_ADMIN                                                                                                                                                                                                                       |

### Task 05.2 migrations (canonical booking identity, ADR-055/056)

| Migration | Change                                                                                                                                                                                                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 190001    | `booking_identities` (`id`, `created_at`): the patient conflict key                                                                                                                                                                                                                                                                      |
| 190002    | `booking_persons.identity_id` (mutable, ix) and `origin_identity_id` (immutable, UNIQUE), both NOT NULL, FK RESTRICT; backfill: one identity per existing person, id = person id                                                                                                                                                         |
| 190003    | `booking_identity_links`, append-only (one row per moved person): source CHECK (`CLAIM_CODE`/`SUPPORT_CASE`/`MIGRATION_CLAIM`), evidence CHECK, status CHECK (ACTIVE ⇔ no `revoked_at`), from ≠ to, ix `(person_id, status)`, `(to_identity_id, status)`; backfills Task 05.1 claims into the owner's SELF identity as `MIGRATION_CLAIM` |
| 190004    | `identity_link_conflicts`: overlapping booking pairs found at link time; UNIQUE `(link_id, booking_a_id, booking_b_id)` (a < b), ix `(resolved_at, id)`; never cancels anything                                                                                                                                                          |
| 190005    | `identity_support_cases`: `case_kind` CHECK (`GUEST_OWNERSHIP`/`IDENTITY_LINK`, default `GUEST_OWNERSHIP`), `evidence_type` CHECK, `link_id` FK → links                                                                                                                                                                                  |

`identity_support_cases.link_id` and `booking_identity_links.case_id` reference each other. Both
are nullable: a link is inserted with its case id, and the case is then updated with the link
id in the same transaction. The integration harness nulls `identity_support_cases.link_id`
before deleting rows.

The UNIQUE `(person_id, starts_at, active_key)` second line on `bookings` is still per person
record. The cross-person identity rule is enforced in code under the identity row lock
(BOOKINGS.md § Concurrency).

### Task 05.2.1 migration (identity-link lifecycle, ADR-057)

| Migration | Change                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200001    | `booking_identity_links`: `superseded_by_link_id` (UNIQUE, FK self) and `superseded_at`; status CHECK replaced by ACTIVE / REVOKED (with revoker) / SUPERSEDED (with successor). `identity_link_conflicts`: `resolution_method` CHECK (`BOOKING_RELEASED`, `LINK_REVOKED`, `UNRECORDED` for rows resolved before it), and an all-or-nothing CHECK over the resolution columns |

A new forward-only migration was used instead of amending 190003/190004. Amending would have
required rebuilding the local dev database and deleting its accounts. A new migration is always
allowed by the [migration policy](../development/DATABASE_MIGRATIONS.md).

## `bookings`

- **Tenant-safe composite FKs:**
  - `(clinic_id, branch_id)` → branches;
  - `(clinic_id, patient_profile_id)` → patient profiles;
  - `(clinic_id, branch_id, assignment_id)` → doctor assignments;
  - `(clinic_id, branch_id, offering_id)` → offerings;
  - `(clinic_id, service_id)` → services.

  The doctor, offering, profile and branch of a booking are therefore always in the same
  clinic and branch.

- **Global FKs:** `person_id` → `booking_persons`, `doctor_profile_id` → `doctor_profiles`
  (the conflict keys).
- **Self references:** `reschedule_of_booking_id` (RESTRICT; MySQL forbids SET NULL on the base
  column of a stored generated column) and `superseded_by_booking_id` (SET NULL).
- **Generated keys:**
  - `active_key = 1` for PENDING_CONFIRMATION, CONFIRMED, CHECKED_IN and IN_PROGRESS;
  - `replacement_key = 1` for a pending replacement.
- **Unique second lines:**
  - `(doctor_profile_id, starts_at, active_key)`;
  - `(person_id, starts_at, active_key)`;
  - `(reschedule_of_booking_id, replacement_key)`.
- **Indexes by access path:**
  - `(doctor_profile_id, starts_at, block_ends_at)`: global doctor busy time;
  - `(person_id, starts_at)`: patient busy time;
  - `(status, confirmation_deadline)`: expiration sweep;
  - `(clinic_id, branch_id, starts_at)`, `(clinic_id, status, id)`,
    `(clinic_id, patient_profile_id, id)`, `(clinic_id, assignment_id, starts_at)`: clinic
    lists.
- **CHECKs:**
  - mode (`SLOT`, `QUEUE`) and the 10 statuses;
  - `mode <> 'SLOT' OR (starts_at, ends_at > starts_at, block_ends_at ≥ ends_at)`;
  - actor kind, price ≤ 1e9 minor units, ISO currency.
- **Snapshot columns:** doctor display name, service names (EN/AR), price, currency, duration,
  buffer, time zone, `cancellation_policy` JSON, `booking_rules` JSON.
- **History:** rows are never deleted. Every status change updates `status`, `status_reason`
  and `status_changed_*`, and appends to `booking_status_history`.

## Migration notes

`20261111170007` failed on its first run in the local dev database. MySQL rejects
`ON DELETE SET NULL` on the base column of a stored generated column. `CREATE TABLE` is atomic
in MySQL 8, so the table did not exist and the migration was not recorded. The never-applied
file was corrected (RESTRICT) before any database recorded it, which is consistent with the
migration policy. No applied migration was changed.

The integration harness clears the booking self-references before deleting rows.
